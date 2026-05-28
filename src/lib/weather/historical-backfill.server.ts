import { addDays, isBefore } from "date-fns"
import type Database from "better-sqlite3"

import {
  readHistoricalBackfillChunkMarker,
  writeHistoricalBackfillChunkMarker,
} from "./backfill-markers.server"
import { IEM_ASOS_REQUEST_URL } from "./config.server"
import { getSqlite } from "./db.server"
import { IemRequestError, fetchIemHistoricalMetars } from "./iem.server"
import { ingestObservations } from "./ingest.server"
import type { HistoricalBackfillChunkMarker } from "./backfill-markers.server"
import type { IemBackfillScope } from "./iem.server"
import type { IngestResult } from "./ingest.server"

export type HistoricalBackfillOptions = {
  scopes: IemBackfillScope[]
  startDate: string
  endDate: string
  chunkDays: number
  rateLimitMs: number
  force: boolean
  dryRun: boolean
  maxRequests: number | null
  maxRetries: number
  retryBaseMs: number
  retryMaxMs: number
  reportTypes?: string[]
}

export type HistoricalBackfillSummary = {
  plannedCount: number
  requestedCount: number
  skippedCount: number
  fetchedCount: number
  insertedCount: number
  duplicateCount: number
}

type Chunk = {
  scope: IemBackfillScope
  startUtc: string
  endUtc: string
}

type ChunkStatusRow = {
  status: string
  fetchedCount: number
  insertedCount: number
  skippedCount: number
  errorText: string | null
  createdAt: string
  finishedAt: string | null
}

type ChunkCompletion = {
  complete: boolean
  source: "sqlite" | "marker" | null
}

export async function runHistoricalBackfill(
  options: HistoricalBackfillOptions,
  onProgress: (message: string) => void = () => {}
): Promise<HistoricalBackfillSummary> {
  const db = getSqlite()
  const chunks = planChunks(options)
  const summary: HistoricalBackfillSummary = {
    plannedCount: chunks.length,
    requestedCount: 0,
    skippedCount: 0,
    fetchedCount: 0,
    insertedCount: 0,
    duplicateCount: 0,
  }

  if (options.dryRun) {
    return summary
  }

  let lastRequestStartedAt = 0

  for (const chunk of chunks) {
    if (
      options.maxRequests !== null &&
      summary.requestedCount >= options.maxRequests
    ) {
      break
    }

    if (!options.force) {
      const completion = chunkCompletion(db, chunk)

      if (completion.complete) {
        summary.skippedCount += 1
        onProgress(
          `Skipping completed ${chunk.scope.type}:${chunk.scope.id} ${chunk.startUtc} -> ${chunk.endUtc} (${completion.source})`
        )
        continue
      }
    }

    markChunkRunning(db, chunk)

    try {
      onProgress(
        `Fetching ${chunk.scope.type}:${chunk.scope.id} ${chunk.startUtc} -> ${chunk.endUtc}`
      )
      const observations = await fetchChunkWithRetry(
        chunk,
        options,
        onProgress,
        async () => {
          const waitMs = Math.max(
            0,
            lastRequestStartedAt + options.rateLimitMs - Date.now()
          )
          if (waitMs > 0) {
            onProgress(
              `Waiting ${formatDuration(waitMs)} before next IEM request`
            )
            await sleep(waitMs)
          }
          lastRequestStartedAt = Date.now()
        }
      )
      const result = ingestObservations(observations, db, IEM_ASOS_REQUEST_URL)
      markChunkFinished(db, chunk, "success", result)
      writeChunkMarker(chunk, result)

      summary.requestedCount += 1
      summary.fetchedCount += result.fetchedCount
      summary.insertedCount += result.insertedCount
      summary.duplicateCount += result.skippedCount

      onProgress(
        `Stored fetched=${result.fetchedCount} inserted=${result.insertedCount} duplicates=${result.skippedCount}`
      )
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error)
      markChunkFinished(
        db,
        chunk,
        "error",
        {
          fetchedCount: 0,
          insertedCount: 0,
          skippedCount: 0,
        },
        errorText
      )
      throw error
    }
  }

  return summary
}

async function fetchChunkWithRetry(
  chunk: Chunk,
  options: HistoricalBackfillOptions,
  onProgress: (message: string) => void,
  beforeAttempt: () => Promise<void>
) {
  for (let attempt = 0; ; attempt += 1) {
    await beforeAttempt()

    try {
      return await fetchIemHistoricalMetars({
        scope: chunk.scope,
        startUtc: chunk.startUtc,
        endUtc: chunk.endUtc,
        reportTypes: options.reportTypes,
      })
    } catch (error) {
      if (!shouldRetryIemError(error) || attempt >= options.maxRetries) {
        throw error
      }

      const waitMs = retryWaitMs(error, attempt, options)
      onProgress(
        `IEM returned ${error.status}; retrying ${chunk.scope.type}:${chunk.scope.id} ${chunk.startUtc} in ${formatDuration(waitMs)} (attempt ${attempt + 1}/${options.maxRetries})`
      )
      await sleep(waitMs)
    }
  }
}

function shouldRetryIemError(error: unknown): error is IemRequestError {
  return (
    error instanceof IemRequestError &&
    (error.status === 429 || error.status === 503 || error.status === 504)
  )
}

function retryWaitMs(
  error: IemRequestError,
  attempt: number,
  options: HistoricalBackfillOptions
) {
  const exponentialMs = Math.min(
    options.retryMaxMs,
    options.retryBaseMs * 2 ** attempt
  )
  const retryAfterMs = error.retryAfterMs ?? 0
  const jitterMs = Math.round(
    Math.random() * Math.min(1000, exponentialMs * 0.1)
  )

  return Math.max(retryAfterMs, exponentialMs) + jitterMs
}

function formatDuration(ms: number) {
  if (ms < 1000) {
    return `${ms}ms`
  }

  return `${Math.ceil(ms / 1000)}s`
}

export function planChunks(options: HistoricalBackfillOptions): Chunk[] {
  return options.scopes.flatMap((scope) => {
    const chunkDays = scope.type === "global" ? 1 : options.chunkDays
    const chunks: Chunk[] = []
    let cursor = parseDateStart(options.startDate)
    const end = parseDateStart(options.endDate)

    while (isBefore(cursor, end)) {
      const next = minDate(addDays(cursor, chunkDays), end)
      chunks.push({
        scope,
        startUtc: formatUtc(cursor),
        endUtc: formatUtc(next),
      })
      cursor = next
    }

    return chunks
  })
}

function chunkCompletion(db: Database.Database, chunk: Chunk): ChunkCompletion {
  const params = chunkParams(chunk)
  const row = db
    .prepare<
      {
        source: string
        scopeType: string
        scopeId: string
        startedAtUtc: string
        endedAtUtc: string
      },
      ChunkStatusRow
    >(
      `
      SELECT status,
        fetched_count AS fetchedCount,
        inserted_count AS insertedCount,
        skipped_count AS skippedCount,
        error_text AS errorText,
        created_at AS createdAt,
        finished_at AS finishedAt
      FROM historical_backfill_chunks
      WHERE source = @source
        AND scope_type = @scopeType
        AND scope_id = @scopeId
        AND started_at_utc = @startedAtUtc
        AND ended_at_utc = @endedAtUtc
      LIMIT 1
    `
    )
    .get(params)

  if (row?.status === "success") {
    writeHistoricalBackfillChunkMarker({
      ...params,
      version: 1,
      status: "success",
      fetchedCount: row.fetchedCount,
      insertedCount: row.insertedCount,
      skippedCount: row.skippedCount,
      errorText: null,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt ?? row.createdAt,
    })
    return { complete: true, source: "sqlite" }
  }

  const marker = readHistoricalBackfillChunkMarker(params)
  if (!marker) {
    return { complete: false, source: null }
  }

  markChunkCompleteFromMarker(db, marker)
  return { complete: true, source: "marker" }
}

function markChunkRunning(db: Database.Database, chunk: Chunk) {
  db.prepare(
    `
    INSERT INTO historical_backfill_chunks (
      source, scope_type, scope_id, started_at_utc, ended_at_utc, status, created_at
    )
    VALUES (
      @source, @scopeType, @scopeId, @startedAtUtc, @endedAtUtc, 'running', @now
    )
    ON CONFLICT(source, scope_type, scope_id, started_at_utc, ended_at_utc)
    DO UPDATE SET
      status = 'running',
      error_text = NULL,
      finished_at = NULL
  `
  ).run({
    ...chunkParams(chunk),
    now: new Date().toISOString(),
  })
}

function markChunkFinished(
  db: Database.Database,
  chunk: Chunk,
  status: "success" | "error",
  result: IngestResult,
  errorText: string | null = null
) {
  db.prepare(
    `
    UPDATE historical_backfill_chunks
    SET status = @status,
      fetched_count = @fetchedCount,
      inserted_count = @insertedCount,
      skipped_count = @skippedCount,
      error_text = @errorText,
      finished_at = @finishedAt
    WHERE source = @source
      AND scope_type = @scopeType
      AND scope_id = @scopeId
      AND started_at_utc = @startedAtUtc
      AND ended_at_utc = @endedAtUtc
  `
  ).run({
    ...chunkParams(chunk),
    status,
    fetchedCount: result.fetchedCount,
    insertedCount: result.insertedCount,
    skippedCount: result.skippedCount,
    errorText,
    finishedAt: new Date().toISOString(),
  })
}

function markChunkCompleteFromMarker(
  db: Database.Database,
  marker: HistoricalBackfillChunkMarker
) {
  db.prepare(
    `
    INSERT INTO historical_backfill_chunks (
      source, scope_type, scope_id, started_at_utc, ended_at_utc, status,
      fetched_count, inserted_count, skipped_count, error_text, created_at, finished_at
    )
    VALUES (
      @source, @scopeType, @scopeId, @startedAtUtc, @endedAtUtc, 'success',
      @fetchedCount, @insertedCount, @skippedCount, NULL, @createdAt, @finishedAt
    )
    ON CONFLICT(source, scope_type, scope_id, started_at_utc, ended_at_utc)
    DO UPDATE SET
      status = 'success',
      fetched_count = @fetchedCount,
      inserted_count = @insertedCount,
      skipped_count = @skippedCount,
      error_text = NULL,
      created_at = @createdAt,
      finished_at = @finishedAt
  `
  ).run(marker)
}

function writeChunkMarker(chunk: Chunk, result: IngestResult) {
  const now = new Date().toISOString()
  writeHistoricalBackfillChunkMarker({
    ...chunkParams(chunk),
    version: 1,
    status: "success",
    fetchedCount: result.fetchedCount,
    insertedCount: result.insertedCount,
    skippedCount: result.skippedCount,
    errorText: null,
    createdAt: now,
    finishedAt: now,
  })
}

function chunkParams(chunk: Chunk) {
  return {
    source: IEM_ASOS_REQUEST_URL,
    scopeType: chunk.scope.type,
    scopeId: chunk.scope.id,
    startedAtUtc: chunk.startUtc,
    endedAtUtc: chunk.endUtc,
  }
}

function parseDateStart(date: string) {
  return new Date(`${date}T00:00:00.000Z`)
}

function formatUtc(date: Date) {
  return date.toISOString().replace(".000Z", "Z")
}

function minDate(left: Date, right: Date) {
  return isBefore(left, right) ? left : right
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
