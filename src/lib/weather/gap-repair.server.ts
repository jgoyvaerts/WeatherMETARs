import type Database from "better-sqlite3"

import { AWC_METARS_CACHE_URL, POLL_INTERVAL_MS } from "./config.server"
import { getSqlite } from "./db.server"
import { runSaoArchiveBackfill } from "./sao-archive.server"
import type { SaoArchiveBackfillSummary } from "./sao-archive.server"

const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_OVERLAP_MS = 60 * 60 * 1000
const DEFAULT_POST_GAP_OVERLAP_MS = 60 * 60 * 1000
const DEFAULT_ARCHIVE_READY_DELAY_MS = 60 * 60 * 1000
const DEFAULT_MAX_GAPS_PER_RUN = 3
const DEFAULT_CONCURRENCY = 8
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_BASE_MS = 1000
const DEFAULT_RETRY_MAX_MS = 30_000
const GAP_REPAIR_SCOPE_TYPE = "gap-repair-v2"

type CurrentIngestSuccessRow = {
  finishedAt: string
}

export type CurrentIngestGap = {
  startedAtUtc: string
  endedAtUtc: string
  open: boolean
}

export type MetarGapRepairWindow = {
  gapStartedAtUtc: string
  gapEndedAtUtc: string
  open: boolean
  startDate: string
  endDate: string
}

export type MetarGapRepairRunSummary = {
  checkedGapCount: number
  plannedWindowCount: number
  repairedWindowCount: number
  skippedCompletedWindowCount: number
  skippedNotReadyCount: number
  skippedWindowCount: number
  fetchedCount: number
  insertedCount: number
  duplicateCount: number
  downloadedFileCount: number
  missingFileCount: number
  failedChunkCount: number
  failedFileCount: number
}

export type MetarGapRepairOptions = {
  db?: Database.Database
  now?: Date
  enabled?: boolean
  minGapMs?: number
  lookbackMs?: number
  overlapMs?: number
  postGapOverlapMs?: number
  archiveReadyDelayMs?: number
  maxGapsPerRun?: number
  maxRequestsPerGap?: number | null
  concurrency?: number
  maxRetries?: number
  retryBaseMs?: number
  retryMaxMs?: number
}

export async function runMetarGapRepair(
  onProgress: (message: string) => void = () => {},
  options: MetarGapRepairOptions = {}
): Promise<MetarGapRepairRunSummary> {
  const resolved = resolveOptions(options)
  const summary = emptySummary()

  if (!resolved.enabled) {
    return summary
  }

  const gaps = findCurrentIngestGaps(resolved.db, {
    now: resolved.now,
    lookbackMs: resolved.lookbackMs,
    minGapMs: resolved.minGapMs,
  })
  const windowPlan = planMetarGapRepairWindows(gaps, resolved)

  summary.checkedGapCount = gaps.length
  summary.plannedWindowCount = windowPlan.windows.length
  summary.skippedNotReadyCount = windowPlan.skippedNotReadyCount
  summary.skippedWindowCount = Math.max(
    0,
    windowPlan.windows.length - resolved.maxGapsPerRun
  )

  for (const window of windowPlan.windows.slice(0, resolved.maxGapsPerRun)) {
    onProgress(
      `Repairing METAR gap ${window.gapStartedAtUtc} -> ${window.gapEndedAtUtc} from SAO archive ${window.startDate} -> ${window.endDate}`
    )

    const backfillSummary = await runSaoArchiveBackfill(
      {
        startDate: window.startDate,
        endDate: window.endDate,
        stationCodes: [],
        scopeType: GAP_REPAIR_SCOPE_TYPE,
        concurrency: resolved.concurrency,
        rateLimitMs: 0,
        force: false,
        dryRun: false,
        maxRequests: resolved.maxRequestsPerGap,
        maxRetries: resolved.maxRetries,
        retryBaseMs: resolved.retryBaseMs,
        retryMaxMs: resolved.retryMaxMs,
        continueOnError: true,
        treatMissingFilesAsErrors: true,
      },
      (message) => onProgress(`SAO gap repair: ${message}`)
    )

    addBackfillSummary(summary, backfillSummary)
    summary.repairedWindowCount += backfillSummary.requestedCount
    summary.skippedCompletedWindowCount += backfillSummary.skippedCount
  }

  return summary
}

export function findCurrentIngestGaps(
  db: Database.Database,
  {
    now,
    lookbackMs,
    minGapMs,
  }: {
    now: Date
    lookbackMs: number
    minGapMs: number
  }
): CurrentIngestGap[] {
  const since = new Date(now.getTime() - lookbackMs).toISOString()
  const rows = db
    .prepare<{ source: string; since: string }, CurrentIngestSuccessRow>(
      `
      SELECT finished_at AS finishedAt
      FROM ingest_runs
      WHERE source = @source
        AND status = 'success'
        AND finished_at IS NOT NULL
        AND (
          finished_at >= @since
          OR finished_at = (
            SELECT MAX(finished_at)
            FROM ingest_runs
            WHERE source = @source
              AND status = 'success'
              AND finished_at IS NOT NULL
              AND finished_at < @since
          )
        )
      ORDER BY finished_at ASC
    `
    )
    .all({ source: AWC_METARS_CACHE_URL, since })
    .filter((row) => Number.isFinite(new Date(row.finishedAt).getTime()))

  const gaps: CurrentIngestGap[] = []

  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]
    const current = rows[index]

    if (gapMs(previous.finishedAt, current.finishedAt) > minGapMs) {
      gaps.push({
        startedAtUtc: previous.finishedAt,
        endedAtUtc: current.finishedAt,
        open: false,
      })
    }
  }

  const latest = rows.at(-1)
  if (
    latest &&
    now.getTime() - new Date(latest.finishedAt).getTime() > minGapMs
  ) {
    gaps.push({
      startedAtUtc: latest.finishedAt,
      endedAtUtc: now.toISOString(),
      open: true,
    })
  }

  return gaps
}

export function planMetarGapRepairWindows(
  gaps: CurrentIngestGap[],
  {
    now,
    overlapMs,
    postGapOverlapMs,
    archiveReadyDelayMs,
  }: {
    now: Date
    overlapMs: number
    postGapOverlapMs: number
    archiveReadyDelayMs: number
  }
) {
  const archiveReadyEnd = floorUtcHour(
    new Date(now.getTime() - archiveReadyDelayMs)
  )
  const windows: MetarGapRepairWindow[] = []
  let skippedNotReadyCount = 0

  for (const gap of gaps) {
    const gapStart = new Date(gap.startedAtUtc)
    const gapEnd = new Date(gap.endedAtUtc)
    const repairStart = floorUtcHour(new Date(gapStart.getTime() - overlapMs))
    const requestedEnd = ceilUtcHour(
      new Date(gapEnd.getTime() + (gap.open ? 0 : postGapOverlapMs))
    )
    const repairEnd = gap.open
      ? minDate(requestedEnd, archiveReadyEnd)
      : requestedEnd

    if (!gap.open && isAfter(repairEnd, archiveReadyEnd)) {
      skippedNotReadyCount += 1
      continue
    }

    if (!isAfter(repairEnd, repairStart)) {
      skippedNotReadyCount += 1
      continue
    }

    windows.push({
      gapStartedAtUtc: formatUtc(gapStart),
      gapEndedAtUtc: formatUtc(gapEnd),
      open: gap.open,
      startDate: formatUtc(repairStart),
      endDate: formatUtc(repairEnd),
    })
  }

  return { windows, skippedNotReadyCount }
}

function resolveOptions(options: MetarGapRepairOptions) {
  return {
    db: options.db ?? getSqlite(),
    now: options.now ?? new Date(),
    enabled: options.enabled ?? process.env.METAR_GAP_REPAIR_ENABLED !== "0",
    minGapMs: options.minGapMs ?? POLL_INTERVAL_MS * 2,
    lookbackMs: options.lookbackMs ?? DEFAULT_LOOKBACK_MS,
    overlapMs: options.overlapMs ?? DEFAULT_OVERLAP_MS,
    postGapOverlapMs: options.postGapOverlapMs ?? DEFAULT_POST_GAP_OVERLAP_MS,
    archiveReadyDelayMs:
      options.archiveReadyDelayMs ?? DEFAULT_ARCHIVE_READY_DELAY_MS,
    maxGapsPerRun: Math.max(
      1,
      options.maxGapsPerRun ?? DEFAULT_MAX_GAPS_PER_RUN
    ),
    maxRequestsPerGap: options.maxRequestsPerGap ?? null,
    concurrency: Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY),
    maxRetries: Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES),
    retryBaseMs: Math.max(0, options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS),
    retryMaxMs: Math.max(0, options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS),
  }
}

function emptySummary(): MetarGapRepairRunSummary {
  return {
    checkedGapCount: 0,
    plannedWindowCount: 0,
    repairedWindowCount: 0,
    skippedCompletedWindowCount: 0,
    skippedNotReadyCount: 0,
    skippedWindowCount: 0,
    fetchedCount: 0,
    insertedCount: 0,
    duplicateCount: 0,
    downloadedFileCount: 0,
    missingFileCount: 0,
    failedChunkCount: 0,
    failedFileCount: 0,
  }
}

function addBackfillSummary(
  summary: MetarGapRepairRunSummary,
  backfillSummary: SaoArchiveBackfillSummary
) {
  summary.fetchedCount += backfillSummary.fetchedCount
  summary.insertedCount += backfillSummary.insertedCount
  summary.duplicateCount += backfillSummary.duplicateCount
  summary.downloadedFileCount += backfillSummary.downloadedFileCount
  summary.missingFileCount += backfillSummary.missingFileCount
  summary.failedChunkCount += backfillSummary.failedChunkCount
  summary.failedFileCount += backfillSummary.failedFileCount
}

function gapMs(startUtc: string, endUtc: string) {
  return new Date(endUtc).getTime() - new Date(startUtc).getTime()
}

function floorUtcHour(date: Date) {
  const floored = new Date(date)
  floored.setUTCMinutes(0, 0, 0)
  return floored
}

function ceilUtcHour(date: Date) {
  const ceiled = floorUtcHour(date)
  if (ceiled.getTime() !== date.getTime()) {
    ceiled.setUTCHours(ceiled.getUTCHours() + 1)
  }
  return ceiled
}

function minDate(left: Date, right: Date) {
  return isAfter(left, right) ? right : left
}

function isAfter(left: Date, right: Date) {
  return left.getTime() > right.getTime()
}

function formatUtc(date: Date) {
  return date.toISOString().replace(".000Z", "Z")
}
