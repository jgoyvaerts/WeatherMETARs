import zlib from "node:zlib"
import { addDays, isBefore } from "date-fns"
import type Database from "better-sqlite3"

import {
  IEM_ASOS_REQUEST_URL,
  IEM_SAO_ARCHIVE_BASE_URL,
  getAwcUserAgent,
} from "./config.server"
import {
  readHistoricalBackfillChunkMarker,
  writeHistoricalBackfillChunkMarker,
} from "./backfill-markers.server"
import type { HistoricalBackfillChunkMarker } from "./backfill-markers.server"
import { getSqlite, retrySqliteBusy } from "./db.server"
import { IemRequestError, fetchIemHistoricalMetars } from "./iem.server"
import { ingestObservations } from "./ingest.server"
import {
  parseRawMetarObservation,
  stationCodeFromRawMetar,
} from "./raw-metar.server"
import type { IngestResult } from "./ingest.server"
import type { MetarObservationInput } from "./types"

const ARCHIVE_START_DATE = "2000-01-01"
const SQLITE_ARCHIVE_WRITE_MAX_RETRIES = 12
const SQLITE_ARCHIVE_WRITE_RETRY_BASE_MS = 1_000
const SQLITE_ARCHIVE_WRITE_RETRY_MAX_MS = 30_000

export type SaoArchiveBackfillOptions = {
  startDate: string
  endDate: string
  stationCodes: string[]
  scopeType?: string
  concurrency: number
  rateLimitMs: number
  force: boolean
  dryRun: boolean
  maxRequests: number | null
  maxRetries: number
  retryBaseMs: number
  retryMaxMs: number
  continueOnError: boolean
  treatMissingFilesAsErrors?: boolean
  newestFirst?: boolean
}

export type SaoArchiveBackfillSummary = {
  plannedCount: number
  requestedCount: number
  skippedCount: number
  fetchedCount: number
  insertedCount: number
  duplicateCount: number
  downloadedFileCount: number
  missingFileCount: number
  failedChunkCount: number
  failedFileCount: number
}

type ArchiveDayChunk = {
  scopeType?: string
  scopeId: string
  startUtc: string
  endUtc: string
}

type ArchiveHourFile = {
  date: Date
  url: string
}

type ArchiveHourResult = {
  observations: MetarObservationInput[]
  missing: boolean
  errorText: string | null
}

type ArchiveFetchResult = {
  observations: MetarObservationInput[]
  downloadedFileCount: number
  missingFileCount: number
  failedFileCount: number
  errorText: string | null
  observationSource: string
  fallbackSource: string | null
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

type ArchiveChunkCompletion = {
  complete: boolean
  source: "sqlite" | "marker" | null
}

class SaoArchiveRequestError extends Error {
  status: number
  retryAfterMs: number | null

  constructor({
    message,
    status,
    retryAfterMs,
  }: {
    message: string
    status: number
    retryAfterMs: number | null
  }) {
    super(message)
    this.name = "SaoArchiveRequestError"
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

export async function runSaoArchiveBackfill(
  options: SaoArchiveBackfillOptions,
  onProgress: (message: string) => void = () => {}
): Promise<SaoArchiveBackfillSummary> {
  const normalizedOptions = normalizeOptions(options)
  const db = getSqlite()
  const chunks = planSaoArchiveChunks(normalizedOptions)
  const summary: SaoArchiveBackfillSummary = {
    plannedCount: chunks.length,
    requestedCount: 0,
    skippedCount: 0,
    fetchedCount: 0,
    insertedCount: 0,
    duplicateCount: 0,
    downloadedFileCount: 0,
    missingFileCount: 0,
    failedChunkCount: 0,
    failedFileCount: 0,
  }

  if (normalizedOptions.dryRun) {
    return summary
  }

  let lastRequestStartedAt = 0
  const stationFilter = stationFilterSet(normalizedOptions.stationCodes)

  for (const chunk of chunks) {
    if (
      normalizedOptions.maxRequests !== null &&
      summary.requestedCount >= normalizedOptions.maxRequests
    ) {
      break
    }

    if (!normalizedOptions.force) {
      const completion = await retryArchiveDbOperation(
        () => archiveChunkCompletion(db, chunk),
        "checking SAO archive chunk status",
        onProgress
      )

      if (completion.complete) {
        summary.skippedCount += 1
        onProgress(
          `Skipping completed SAO archive ${chunk.startUtc} -> ${chunk.endUtc} (${completion.source})`
        )
        continue
      }
    }

    const waitMs = Math.max(
      0,
      lastRequestStartedAt + normalizedOptions.rateLimitMs - Date.now()
    )
    if (waitMs > 0) {
      onProgress(`Waiting ${formatDuration(waitMs)} before next archive day`)
      await sleep(waitMs)
    }

    lastRequestStartedAt = Date.now()
    await retryArchiveDbOperation(
      () => markArchiveChunkRunning(db, chunk),
      "marking SAO archive chunk running",
      onProgress
    )
    let chunkMarked = false
    let terminalStatusWriteStarted = false

    try {
      onProgress(`Fetching SAO archive ${chunk.startUtc} -> ${chunk.endUtc}`)
      const files = archiveFilesForChunk(chunk)
      const archiveResult = await archiveResultWithFallback(
        chunk,
        files,
        normalizedOptions,
        stationFilter,
        onProgress
      )
      const result = ingestObservations(
        archiveResult.observations,
        db,
        archiveResult.observationSource
      )
      const allArchiveFilesMissing =
        archiveResult.missingFileCount > 0 &&
        archiveResult.downloadedFileCount === 0 &&
        archiveResult.failedFileCount === 0
      const missingFilesResolvedByFallback =
        archiveResult.fallbackSource !== null &&
        archiveResult.observations.length > 0
      const missingFilesAreErrors =
        !missingFilesResolvedByFallback && archiveResult.missingFileCount > 0
      const status =
        archiveResult.failedFileCount > 0 || missingFilesAreErrors
          ? "error"
          : "success"
      const errorText =
        archiveResult.errorText ??
        (missingFilesAreErrors
          ? allArchiveFilesMissing
            ? "All hourly SAO archive files are missing and IEM CGI fallback returned no observations"
            : `${archiveResult.missingFileCount} hourly SAO archive file(s) missing`
          : null)
      terminalStatusWriteStarted = true
      await retryArchiveDbOperation(
        () => markArchiveChunkFinished(db, chunk, status, result, errorText),
        "marking SAO archive chunk finished",
        onProgress
      )
      if (status === "success") {
        writeArchiveChunkMarker(chunk, result)
      }
      chunkMarked = true

      summary.requestedCount += 1
      summary.fetchedCount += result.fetchedCount
      summary.insertedCount += result.insertedCount
      summary.duplicateCount += result.skippedCount
      summary.downloadedFileCount += archiveResult.downloadedFileCount
      summary.missingFileCount += archiveResult.missingFileCount
      summary.failedFileCount += archiveResult.failedFileCount
      if (status === "error") {
        summary.failedChunkCount += 1
      }

      onProgress(
        [
          `Stored status=${status}`,
          `source=${archiveResult.fallbackSource ?? "sao-archive"}`,
          `files=${archiveResult.downloadedFileCount}`,
          `missingFiles=${archiveResult.missingFileCount}`,
          `failedFiles=${archiveResult.failedFileCount}`,
          `fetched=${result.fetchedCount}`,
          `inserted=${result.insertedCount}`,
          `duplicates=${result.skippedCount}`,
          errorText ? `error=${errorText}` : null,
        ]
          .filter(Boolean)
          .join(" ")
      )

      if (status === "error" && !normalizedOptions.continueOnError) {
        throw new Error(
          `SAO archive chunk ${chunk.startUtc} had ${archiveResult.failedFileCount} failed file(s) and ${archiveResult.missingFileCount} missing file(s)`
        )
      }
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error)
      if (!chunkMarked && !terminalStatusWriteStarted) {
        await retryArchiveDbOperation(
          () =>
            markArchiveChunkFinished(
              db,
              chunk,
              "error",
              {
                fetchedCount: 0,
                insertedCount: 0,
                skippedCount: 0,
              },
              errorText
            ),
          "marking SAO archive chunk error",
          onProgress
        )
      }
      throw error
    }
  }

  return summary
}

export function planSaoArchiveChunks(
  options: Pick<SaoArchiveBackfillOptions, "startDate" | "endDate"> &
    Partial<
      Pick<
        SaoArchiveBackfillOptions,
        "stationCodes" | "scopeType" | "newestFirst"
      >
    >
) {
  const chunks: ArchiveDayChunk[] = []
  const scopeId = archiveScopeId(options.stationCodes ?? [])
  let cursor = parseDateStart(clampArchiveStart(options.startDate))
  const end = parseDateStart(options.endDate)

  while (isBefore(cursor, end)) {
    const next = minDate(addDays(cursor, 1), end)
    const chunk: ArchiveDayChunk = {
      scopeId,
      startUtc: formatUtc(cursor),
      endUtc: formatUtc(next),
    }
    if (options.scopeType) {
      chunk.scopeType = options.scopeType
    }
    chunks.push(chunk)
    cursor = next
  }

  return options.newestFirst ? chunks.reverse() : chunks
}

export function parseSaoArchiveText({
  text,
  chunkStartUtc,
  stationFilter,
}: {
  text: string
  chunkStartUtc: string
  stationFilter?: ReadonlySet<string> | null
}) {
  const chunkStart = new Date(chunkStartUtc)
  const observations: MetarObservationInput[] = []
  const normalizedText = stripNonLineControlCharacters(text)
  const lines = normalizedText.split("\n")
  let reportType: "METAR" | "SPECI" | null = null
  let reportBuffer = ""

  for (const line of lines) {
    const trimmed = line.replace(/\r/g, "").trim()
    if (!trimmed) {
      continue
    }

    if (isBulletinByteCount(trimmed) || isWmoHeader(trimmed)) {
      reportType = null
      reportBuffer = ""
      continue
    }

    if (trimmed === "METAR" || trimmed === "SPECI") {
      reportType = trimmed
      reportBuffer = ""
      continue
    }

    if (!reportType) {
      continue
    }

    reportBuffer = reportBuffer ? `${reportBuffer} ${trimmed}` : trimmed

    while (reportBuffer.includes("=")) {
      const separatorIndex = reportBuffer.indexOf("=")
      const rawText = normalizeRawReport(reportBuffer.slice(0, separatorIndex))
      reportBuffer = reportBuffer.slice(separatorIndex + 1).trim()

      if (!rawText) {
        continue
      }

      const stationCode = stationCodeFromRawMetar(rawText)
      if (!stationCode || (stationFilter && !stationFilter.has(stationCode))) {
        continue
      }

      const observedAtUtc = observedAtUtcFromRawMetar(rawText, chunkStart)
      if (!observedAtUtc) {
        continue
      }

      const observation = parseRawMetarObservation({
        rawText,
        observedAtUtc,
        reportType,
      })
      if (observation) {
        observations.push(observation)
      }
    }
  }

  return observations
}

function normalizeOptions(options: SaoArchiveBackfillOptions) {
  return {
    ...options,
    startDate: clampArchiveStart(options.startDate),
    concurrency: Math.max(1, options.concurrency),
    newestFirst: options.newestFirst ?? false,
  }
}

function clampArchiveStart(startDate: string) {
  return startDate < ARCHIVE_START_DATE ? ARCHIVE_START_DATE : startDate
}

async function fetchArchiveFiles(
  files: ArchiveHourFile[],
  options: SaoArchiveBackfillOptions,
  stationFilter: ReadonlySet<string> | null,
  onProgress: (message: string) => void
): Promise<ArchiveFetchResult> {
  const results = await mapConcurrent(
    files,
    options.concurrency,
    async (file) => {
      try {
        return await fetchArchiveHourWithRetry(
          file,
          options,
          stationFilter,
          onProgress
        )
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error)
        onProgress(`Failed ${file.url}: ${errorText}`)
        return {
          observations: [],
          missing: false,
          errorText,
        }
      }
    }
  )
  const errors = results.flatMap((result) =>
    result.errorText ? [result.errorText] : []
  )

  return {
    observations: results.flatMap((result) => result.observations),
    downloadedFileCount: results.filter(
      (result) => !result.missing && !result.errorText
    ).length,
    missingFileCount: results.filter((result) => result.missing).length,
    failedFileCount: errors.length,
    errorText: errors.length > 0 ? errors.join("\n") : null,
    observationSource: IEM_SAO_ARCHIVE_BASE_URL,
    fallbackSource: null,
  }
}

async function archiveResultWithFallback(
  chunk: ArchiveDayChunk,
  files: ArchiveHourFile[],
  options: SaoArchiveBackfillOptions,
  stationFilter: ReadonlySet<string> | null,
  onProgress: (message: string) => void
): Promise<ArchiveFetchResult> {
  const archiveResult = await fetchArchiveFiles(
    files,
    options,
    stationFilter,
    onProgress
  )

  if (
    archiveResult.missingFileCount !== files.length ||
    archiveResult.downloadedFileCount !== 0 ||
    archiveResult.failedFileCount !== 0
  ) {
    return archiveResult
  }

  onProgress(
    `SAO archive has no hourly files for ${chunk.startUtc} -> ${chunk.endUtc}; falling back to IEM CGI`
  )

  try {
    const observations = await fetchIemFallbackObservations(
      chunk,
      options,
      onProgress
    )

    return {
      ...archiveResult,
      observations,
      observationSource: IEM_ASOS_REQUEST_URL,
      fallbackSource: "iem-cgi",
      errorText:
        observations.length === 0
          ? "IEM CGI fallback returned no observations"
          : archiveResult.errorText,
    }
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error)
    return {
      ...archiveResult,
      errorText: `IEM CGI fallback failed: ${errorText}`,
    }
  }
}

async function fetchIemFallbackObservations(
  chunk: ArchiveDayChunk,
  options: SaoArchiveBackfillOptions,
  onProgress: (message: string) => void
) {
  const observations: MetarObservationInput[] = []

  for (const scope of iemFallbackScopes(options.stationCodes)) {
    const scopeObservations = await fetchIemFallbackWithRetry(
      scope,
      chunk,
      options,
      onProgress
    )

    for (const observation of scopeObservations) {
      observations.push(observation)
    }
  }

  return observations
}

async function fetchIemFallbackWithRetry(
  scope: { type: "global"; id: "all" } | { type: "station"; id: string },
  chunk: ArchiveDayChunk,
  options: SaoArchiveBackfillOptions,
  onProgress: (message: string) => void
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchIemHistoricalMetars({
        scope,
        startUtc: chunk.startUtc,
        endUtc: chunk.endUtc,
      })
    } catch (error) {
      if (
        !shouldRetryIemFallbackError(error) ||
        attempt >= options.maxRetries
      ) {
        throw error
      }

      const waitMs = retryWaitMs(error, attempt, options)
      onProgress(
        `IEM CGI fallback failed (${archiveErrorLabel(error)}); retrying ${scope.type}:${scope.id} ${chunk.startUtc} in ${formatDuration(waitMs)} (attempt ${attempt + 1}/${options.maxRetries})`
      )
      await sleep(waitMs)
    }
  }
}

function iemFallbackScopes(stationCodes: string[]) {
  const normalizedStationCodes = stationCodes
    .map((stationCode) => stationCode.trim().toUpperCase())
    .filter(Boolean)

  if (normalizedStationCodes.length === 0) {
    return [{ type: "global" as const, id: "all" as const }]
  }

  return normalizedStationCodes.map((id) => ({ type: "station" as const, id }))
}

function shouldRetryIemFallbackError(error: unknown) {
  return (
    (error instanceof IemRequestError &&
      (error.status === 429 || error.status === 503 || error.status === 504)) ||
    isTransientArchiveError(error)
  )
}

async function fetchArchiveHourWithRetry(
  file: ArchiveHourFile,
  options: SaoArchiveBackfillOptions,
  stationFilter: ReadonlySet<string> | null,
  onProgress: (message: string) => void
): Promise<ArchiveHourResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchArchiveHour(file, stationFilter)
    } catch (error) {
      if (!shouldRetryArchiveError(error) || attempt >= options.maxRetries) {
        throw error
      }

      const waitMs = retryWaitMs(error, attempt, options)
      onProgress(
        `Archive fetch failed (${archiveErrorLabel(error)}); retrying ${file.url} in ${formatDuration(waitMs)} (attempt ${attempt + 1}/${options.maxRetries})`
      )
      await sleep(waitMs)
    }
  }
}

async function fetchArchiveHour(
  file: ArchiveHourFile,
  stationFilter: ReadonlySet<string> | null
): Promise<ArchiveHourResult> {
  const response = await fetch(file.url, {
    headers: {
      "User-Agent": getAwcUserAgent(),
      Connection: "close",
    },
  })

  if (response.status === 404) {
    return {
      observations: [],
      missing: true,
      errorText: null,
    }
  }

  if (!response.ok) {
    const text = await response.text()
    throw new SaoArchiveRequestError({
      message: `IEM SAO archive request failed ${response.status} ${response.statusText}: ${text.slice(0, 500)}`,
      status: response.status,
      retryAfterMs: retryAfterHeaderMs(response.headers.get("retry-after")),
    })
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  const text = zlib.gunzipSync(buffer).toString("utf8")

  return {
    observations: parseSaoArchiveText({
      text,
      chunkStartUtc: file.date.toISOString(),
      stationFilter,
    }),
    missing: false,
    errorText: null,
  }
}

function archiveFilesForChunk(chunk: ArchiveDayChunk) {
  const cursor = floorUtcHour(new Date(chunk.startUtc))
  const end = new Date(chunk.endUtc)
  const files: ArchiveHourFile[] = []

  while (isBefore(cursor, end)) {
    const date = new Date(cursor)
    files.push({
      date,
      url: saoArchiveFileUrl(date),
    })
    cursor.setUTCHours(cursor.getUTCHours() + 1)
  }

  return files
}

function saoArchiveFileUrl(date: Date) {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  const day = String(date.getUTCDate()).padStart(2, "0")
  const hour = String(date.getUTCHours()).padStart(2, "0")
  const shortYear = String(year % 100).padStart(2, "0")

  return `${IEM_SAO_ARCHIVE_BASE_URL}/${year}_${month}/${shortYear}${month}${day}${hour}.sao.gz`
}

function observedAtUtcFromRawMetar(rawText: string, chunkStart: Date) {
  const match = rawText.match(/(?:^|\s)(\d{2})(\d{2})(\d{2})Z(?=\s|$)/)
  if (!match) {
    return null
  }

  const day = Number(match[1])
  const hour = Number(match[2])
  const minute = Number(match[3])

  if (!validObservedTimeParts(day, hour, minute)) {
    return null
  }

  const candidates = [-1, 0, 1].flatMap((monthOffset) => {
    const candidate = new Date(
      Date.UTC(
        chunkStart.getUTCFullYear(),
        chunkStart.getUTCMonth() + monthOffset,
        day,
        hour,
        minute,
        0,
        0
      )
    )

    return candidate.getUTCDate() === day ? [candidate] : []
  })

  if (candidates.length === 0) {
    return null
  }

  const closest = candidates.reduce((best, candidate) => {
    const bestDistance = Math.abs(best.getTime() - chunkStart.getTime())
    const candidateDistance = Math.abs(
      candidate.getTime() - chunkStart.getTime()
    )
    return candidateDistance < bestDistance ? candidate : best
  })

  return closest.toISOString()
}

function validObservedTimeParts(day: number, hour: number, minute: number) {
  return (
    Number.isInteger(day) &&
    day >= 1 &&
    day <= 31 &&
    Number.isInteger(hour) &&
    hour >= 0 &&
    hour <= 23 &&
    Number.isInteger(minute) &&
    minute >= 0 &&
    minute <= 59
  )
}

function normalizeRawReport(report: string) {
  return report.replace(/\s+/g, " ").replace(/\s+$/, "").trim()
}

function isBulletinByteCount(value: string) {
  return /^\d{3,4}$/.test(value)
}

function isWmoHeader(value: string) {
  return /^[A-Z]{4}\d{2}\s+[A-Z]{4}\s+\d{6}/.test(value)
}

function stationFilterSet(stationCodes: string[]) {
  if (stationCodes.length === 0) {
    return null
  }

  const codes = new Set<string>()
  for (const stationCode of stationCodes) {
    const clean = stationCode.trim().toUpperCase()
    if (!clean) {
      continue
    }

    codes.add(clean)
    if (/^[A-Z0-9]{3}$/.test(clean)) {
      codes.add(`K${clean}`)
    }
  }

  return codes
}

function archiveChunkCompletion(
  db: Database.Database,
  chunk: ArchiveDayChunk
): ArchiveChunkCompletion {
  const params = archiveChunkParams(chunk)
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

  markArchiveChunkCompleteFromMarker(db, marker)
  return { complete: true, source: "marker" }
}

function markArchiveChunkRunning(
  db: Database.Database,
  chunk: ArchiveDayChunk
) {
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
    ...archiveChunkParams(chunk),
    now: new Date().toISOString(),
  })
}

function markArchiveChunkFinished(
  db: Database.Database,
  chunk: ArchiveDayChunk,
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
    ...archiveChunkParams(chunk),
    status,
    fetchedCount: result.fetchedCount,
    insertedCount: result.insertedCount,
    skippedCount: result.skippedCount,
    errorText,
    finishedAt: new Date().toISOString(),
  })
}

function markArchiveChunkCompleteFromMarker(
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

function writeArchiveChunkMarker(chunk: ArchiveDayChunk, result: IngestResult) {
  const now = new Date().toISOString()
  writeHistoricalBackfillChunkMarker({
    ...archiveChunkParams(chunk),
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

function archiveChunkParams(chunk: ArchiveDayChunk) {
  return {
    source: IEM_SAO_ARCHIVE_BASE_URL,
    scopeType: chunk.scopeType ?? "sao-archive",
    scopeId: chunk.scopeId,
    startedAtUtc: chunk.startUtc,
    endedAtUtc: chunk.endUtc,
  }
}

function archiveScopeId(stationCodes: string[]) {
  if (stationCodes.length === 0) {
    return "all"
  }

  return `station:${stationCodes
    .map((stationCode) => stationCode.trim().toUpperCase())
    .filter(Boolean)
    .sort()
    .join(",")}`
}

function retryArchiveDbOperation<TResult>(
  operation: () => TResult,
  action: string,
  onProgress: (message: string) => void
) {
  return retrySqliteBusy(operation, {
    maxRetries: SQLITE_ARCHIVE_WRITE_MAX_RETRIES,
    retryBaseMs: SQLITE_ARCHIVE_WRITE_RETRY_BASE_MS,
    retryMaxMs: SQLITE_ARCHIVE_WRITE_RETRY_MAX_MS,
    onRetry: ({ attempt, maxRetries, waitMs }) => {
      onProgress(
        `SQLite busy while ${action}; retrying in ${formatDuration(waitMs)} (attempt ${attempt}/${maxRetries})`
      )
    },
  })
}

async function mapConcurrent<TInput, TOutput>(
  inputs: TInput[],
  concurrency: number,
  mapper: (input: TInput) => Promise<TOutput>
) {
  const results = new Array<TOutput>(inputs.length)
  let nextIndex = 0

  async function worker() {
    for (;;) {
      const index = nextIndex
      nextIndex += 1

      if (index >= inputs.length) {
        return
      }

      results[index] = await mapper(inputs[index])
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker())
  )

  return results
}

function stripNonLineControlCharacters(text: string) {
  let output = ""

  for (const character of text) {
    const code = character.charCodeAt(0)
    const isAllowedWhitespace = code === 9 || code === 10 || code === 13
    const isControl = code < 32 || code === 127
    output += isControl && !isAllowedWhitespace ? "\n" : character
  }

  return output
}

function shouldRetryArchiveError(error: unknown) {
  return (
    (error instanceof SaoArchiveRequestError &&
      (error.status === 429 || error.status === 503 || error.status === 504)) ||
    isTransientArchiveError(error)
  )
}

function retryWaitMs(
  error: unknown,
  attempt: number,
  options: SaoArchiveBackfillOptions
) {
  const exponentialMs = Math.min(
    options.retryMaxMs,
    options.retryBaseMs * 2 ** attempt
  )
  const retryAfterMs =
    error instanceof SaoArchiveRequestError ? (error.retryAfterMs ?? 0) : 0
  const jitterMs = Math.round(
    Math.random() * Math.min(1000, exponentialMs * 0.1)
  )

  return Math.max(retryAfterMs, exponentialMs) + jitterMs
}

function archiveErrorLabel(error: unknown) {
  if (error instanceof SaoArchiveRequestError) {
    return `${error.status}`
  }

  if (error instanceof Error) {
    const code = errorCode(error)
    return code ? `${error.message}; ${code}` : error.message
  }

  return String(error)
}

function isTransientArchiveError(error: unknown) {
  if (!(error instanceof Error)) {
    return false
  }

  const code = errorCode(error)
  if (
    code &&
    [
      "ECONNRESET",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "UND_ERR_SOCKET",
      "Z_BUF_ERROR",
      "Z_DATA_ERROR",
    ].includes(code)
  ) {
    return true
  }

  const message = error.message.toLowerCase()
  return (
    message.includes("fetch failed") ||
    message.includes("other side closed") ||
    message.includes("terminated")
  )
}

function errorCode(error: Error): string | null {
  const maybeError = error as Error & {
    code?: unknown
    cause?: unknown
  }
  if (typeof maybeError.code === "string") {
    return maybeError.code
  }

  if (
    maybeError.cause &&
    typeof maybeError.cause === "object" &&
    "code" in maybeError.cause
  ) {
    const causeCode = (maybeError.cause as { code?: unknown }).code
    return typeof causeCode === "string" ? causeCode : null
  }

  return null
}

function retryAfterHeaderMs(value: string | null) {
  if (!value) {
    return null
  }

  const seconds = Number(value)
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000)
  }

  const date = new Date(value)
  if (!Number.isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now())
  }

  return null
}

function parseDateStart(date: string) {
  return date.includes("T") ? new Date(date) : new Date(`${date}T00:00:00.000Z`)
}

function formatUtc(date: Date) {
  return date.toISOString().replace(".000Z", "Z")
}

function minDate(left: Date, right: Date) {
  return isBefore(left, right) ? left : right
}

function floorUtcHour(date: Date) {
  const floored = new Date(date)
  floored.setUTCMinutes(0, 0, 0)
  return floored
}

function formatDuration(ms: number) {
  if (ms < 1000) {
    return `${ms}ms`
  }

  return `${Math.ceil(ms / 1000)}s`
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
