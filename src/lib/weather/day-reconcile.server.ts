import type Database from "better-sqlite3"

import { getSqlite } from "./db.server"
import { utcRangeForLocalDate } from "./dates"
import { readRawMetarEntries } from "./raw-files.server"
import { findStationDayObservationGaps } from "./station-day-gaps.server"

const DEFAULT_ARCHIVE_READY_DELAY_MS = 60 * 60 * 1000
const DEFAULT_LOOKBACK_DAYS = 1
const DEFAULT_MAX_WINDOWS_PER_RUN = 48
const DEFAULT_MAX_STATION_GAP_WINDOWS_PER_RUN = 24
const DEFAULT_CONCURRENCY = 8
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_BASE_MS = 1000
const DEFAULT_RETRY_MAX_MS = 30_000

export const METAR_DAY_RECONCILE_INTERVAL_MS = 60 * 60 * 1000

export type MetarDayReconcileWindow = {
  startDate: string
  endDate: string
}

export type MetarStationGapRepairWindow = {
  stationCode: string
  localDate: string
  startDate: string
  endDate: string
  gapCount: number
  priority: number
}

export type MetarDayReconcileRunSummary = {
  checkedWindowCount: number
  plannedWindowCount: number
  reconciledWindowCount: number
  skippedCompletedWindowCount: number
  skippedNotReadyCount: number
  skippedWindowCount: number
  checkedStationDayCount: number
  detectedStationGapCount: number
  plannedStationGapWindowCount: number
  repairedStationGapWindowCount: number
  skippedStationGapWindowCount: number
  failedStationGapWindowCount: number
  fetchedCount: number
  insertedCount: number
  duplicateCount: number
  downloadedFileCount: number
  missingFileCount: number
  failedChunkCount: number
  failedFileCount: number
}

export type MetarDayReconcileOptions = {
  db?: Database.Database
  now?: Date
  enabled?: boolean
  stationGapRepairEnabled?: boolean
  lookbackDays?: number
  archiveReadyDelayMs?: number
  maxWindowsPerRun?: number
  maxStationGapWindowsPerRun?: number
  concurrency?: number
  maxRetries?: number
  retryBaseMs?: number
  retryMaxMs?: number
}

type SaoArchiveBackfillSummary = {
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

type HistoricalBackfillSummary = {
  requestedCount: number
  skippedCount: number
  fetchedCount: number
  insertedCount: number
  duplicateCount: number
}

type StationDayCandidateRow = {
  stationCode: string
  localDate: string
  timezone: string
  priority: number
}

export async function runMetarDayReconcile(
  onProgress: (message: string) => void = () => {},
  options: MetarDayReconcileOptions = {}
): Promise<MetarDayReconcileRunSummary> {
  const resolved = resolveOptions(options)
  const summary = emptySummary()

  if (!resolved.enabled) {
    return summary
  }

  const plan = planMetarDayReconcileWindows(resolved)
  const windows = plan.windows.slice(0, resolved.maxWindowsPerRun)
  const stationGapPlan = resolved.stationGapRepairEnabled
    ? planMetarStationGapRepairWindows(resolved)
    : {
        windows: [],
        checkedStationDayCount: 0,
        detectedStationGapCount: 0,
      }
  const stationGapWindows = stationGapPlan.windows.slice(
    0,
    resolved.maxStationGapWindowsPerRun
  )

  summary.checkedWindowCount = plan.windows.length
  summary.plannedWindowCount = plan.windows.length
  summary.skippedNotReadyCount = plan.skippedNotReadyCount
  summary.skippedWindowCount = Math.max(0, plan.windows.length - windows.length)
  summary.checkedStationDayCount = stationGapPlan.checkedStationDayCount
  summary.detectedStationGapCount = stationGapPlan.detectedStationGapCount
  summary.plannedStationGapWindowCount = stationGapPlan.windows.length
  summary.skippedStationGapWindowCount = Math.max(
    0,
    stationGapPlan.windows.length - stationGapWindows.length
  )

  if (windows.length === 0 && stationGapWindows.length === 0) {
    return summary
  }

  const { runSaoArchiveBackfill } = await import("./sao-archive.server")
  const { runHistoricalBackfill } = await import("./historical-backfill.server")

  for (const window of windows) {
    const backfillSummary = await runSaoArchiveBackfill(
      {
        startDate: window.startDate,
        endDate: window.endDate,
        stationCodes: [],
        concurrency: resolved.concurrency,
        rateLimitMs: 0,
        force: false,
        dryRun: false,
        maxRequests: null,
        maxRetries: resolved.maxRetries,
        retryBaseMs: resolved.retryBaseMs,
        retryMaxMs: resolved.retryMaxMs,
        continueOnError: true,
        treatMissingFilesAsErrors: true,
      },
      (message) => {
        if (!message.startsWith("Skipping completed SAO archive ")) {
          onProgress(`SAO day reconcile: ${message}`)
        }
      }
    )

    addBackfillSummary(summary, backfillSummary)
  }

  for (const window of stationGapWindows) {
    onProgress(
      `Repairing station METAR gap ${window.stationCode} ${window.localDate} ${window.startDate} -> ${window.endDate} gaps=${window.gapCount}`
    )

    try {
      const backfillSummary = await runHistoricalBackfill(
        {
          scopes: [{ type: "station", id: window.stationCode }],
          startDate: window.startDate,
          endDate: window.endDate,
          chunkDays: 1,
          rateLimitMs: 0,
          force: true,
          dryRun: false,
          maxRequests: null,
          maxRetries: resolved.maxRetries,
          retryBaseMs: resolved.retryBaseMs,
          retryMaxMs: resolved.retryMaxMs,
        },
        (message) => onProgress(`IEM station gap repair: ${message}`)
      )

      addHistoricalBackfillSummary(summary, backfillSummary)
      summary.repairedStationGapWindowCount += backfillSummary.requestedCount
      summary.skippedStationGapWindowCount += backfillSummary.skippedCount
    } catch (error) {
      summary.failedStationGapWindowCount += 1
      onProgress(
        `IEM station gap repair failed ${window.stationCode} ${window.startDate} -> ${window.endDate}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  return summary
}

export function planMetarDayReconcileWindows({
  now,
  lookbackDays,
  archiveReadyDelayMs,
}: {
  now: Date
  lookbackDays: number
  archiveReadyDelayMs: number
}) {
  const currentDayStart = floorUtcDay(now)
  const start = addUtcDays(currentDayStart, -lookbackDays)
  const end = floorUtcHour(new Date(now.getTime() - archiveReadyDelayMs))
  const windows: MetarDayReconcileWindow[] = []

  if (!isAfter(end, start)) {
    return { windows, skippedNotReadyCount: 1 }
  }

  for (let cursor = start; isAfter(end, cursor); ) {
    const next = addUtcHours(cursor, 1)
    windows.push({
      startDate: formatUtc(cursor),
      endDate: formatUtc(next),
    })
    cursor = next
  }

  return { windows, skippedNotReadyCount: 0 }
}

export function planMetarStationGapRepairWindows({
  db,
  now,
  lookbackDays,
  archiveReadyDelayMs,
  maxStationGapWindowsPerRun = DEFAULT_MAX_STATION_GAP_WINDOWS_PER_RUN,
}: {
  db: Database.Database
  now: Date
  lookbackDays: number
  archiveReadyDelayMs: number
  maxStationGapWindowsPerRun?: number
}) {
  const archiveReadyEnd = floorUtcHour(
    new Date(now.getTime() - archiveReadyDelayMs)
  )
  const windows: MetarStationGapRepairWindow[] = []
  let checkedStationDayCount = 0
  let detectedStationGapCount = 0

  for (const candidate of stationDayCandidates(db, now, lookbackDays)) {
    const { startUtc, endUtc } = utcRangeForLocalDate(
      candidate.localDate,
      candidate.timezone
    )
    const effectiveEnd = minDate(new Date(endUtc), archiveReadyEnd)

    if (!isAfter(effectiveEnd, new Date(startUtc))) {
      continue
    }

    checkedStationDayCount += 1

    const gaps = findStationDayObservationGaps(
      readRawMetarEntries(candidate.stationCode, candidate.localDate),
      {
        startUtc,
        endUtc: formatUtc(effectiveEnd),
      }
    )

    detectedStationGapCount += gaps.length

    if (gaps.length === 0) {
      continue
    }

    const start = gaps
      .map((gap) => floorUtcHour(new Date(gap.startedAtUtc)))
      .reduce((minimum, current) => minDate(minimum, current))
    const end = gaps
      .map((gap) => ceilUtcHour(new Date(gap.endedAtUtc)))
      .reduce((maximum, current) => maxDate(maximum, current))

    if (!isAfter(end, start)) {
      continue
    }

    windows.push({
      stationCode: candidate.stationCode,
      localDate: candidate.localDate,
      startDate: formatUtc(start),
      endDate: formatUtc(end),
      gapCount: gaps.length,
      priority: candidate.priority,
    })

    if (windows.length >= maxStationGapWindowsPerRun) {
      return {
        windows: mergeStationGapRepairWindows(windows),
        checkedStationDayCount,
        detectedStationGapCount,
      }
    }
  }

  return {
    windows: mergeStationGapRepairWindows(windows),
    checkedStationDayCount,
    detectedStationGapCount,
  }
}

function resolveOptions(options: MetarDayReconcileOptions) {
  return {
    db: options.db ?? getSqlite(),
    now: options.now ?? new Date(),
    enabled: options.enabled ?? process.env.METAR_DAY_RECONCILE_ENABLED !== "0",
    stationGapRepairEnabled:
      options.stationGapRepairEnabled ??
      process.env.METAR_STATION_GAP_REPAIR_ENABLED !== "0",
    lookbackDays: Math.max(0, options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS),
    archiveReadyDelayMs:
      options.archiveReadyDelayMs ?? DEFAULT_ARCHIVE_READY_DELAY_MS,
    maxWindowsPerRun: Math.max(
      1,
      options.maxWindowsPerRun ?? DEFAULT_MAX_WINDOWS_PER_RUN
    ),
    maxStationGapWindowsPerRun: Math.max(
      1,
      options.maxStationGapWindowsPerRun ??
        DEFAULT_MAX_STATION_GAP_WINDOWS_PER_RUN
    ),
    concurrency: Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY),
    maxRetries: Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES),
    retryBaseMs: Math.max(0, options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS),
    retryMaxMs: Math.max(0, options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS),
  }
}

function emptySummary(): MetarDayReconcileRunSummary {
  return {
    checkedWindowCount: 0,
    plannedWindowCount: 0,
    reconciledWindowCount: 0,
    skippedCompletedWindowCount: 0,
    skippedNotReadyCount: 0,
    skippedWindowCount: 0,
    checkedStationDayCount: 0,
    detectedStationGapCount: 0,
    plannedStationGapWindowCount: 0,
    repairedStationGapWindowCount: 0,
    skippedStationGapWindowCount: 0,
    failedStationGapWindowCount: 0,
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
  summary: MetarDayReconcileRunSummary,
  backfillSummary: SaoArchiveBackfillSummary
) {
  summary.reconciledWindowCount += backfillSummary.requestedCount
  summary.skippedCompletedWindowCount += backfillSummary.skippedCount
  summary.fetchedCount += backfillSummary.fetchedCount
  summary.insertedCount += backfillSummary.insertedCount
  summary.duplicateCount += backfillSummary.duplicateCount
  summary.downloadedFileCount += backfillSummary.downloadedFileCount
  summary.missingFileCount += backfillSummary.missingFileCount
  summary.failedChunkCount += backfillSummary.failedChunkCount
  summary.failedFileCount += backfillSummary.failedFileCount
}

function addHistoricalBackfillSummary(
  summary: MetarDayReconcileRunSummary,
  backfillSummary: HistoricalBackfillSummary
) {
  summary.fetchedCount += backfillSummary.fetchedCount
  summary.insertedCount += backfillSummary.insertedCount
  summary.duplicateCount += backfillSummary.duplicateCount
}

function stationDayCandidates(
  db: Database.Database,
  now: Date,
  lookbackDays: number
): StationDayCandidateRow[] {
  const currentUtcDay = floorUtcDay(now)
  const minLocalDate = formatDate(addUtcDays(currentUtcDay, -lookbackDays - 2))
  const maxLocalDate = formatDate(addUtcDays(currentUtcDay, 2))

  return db
    .prepare<
      { minLocalDate: string; maxLocalDate: string },
      StationDayCandidateRow
    >(
      `
      SELECT ids.station_code AS stationCode,
        raw.local_date AS localDate,
        COALESCE(stations.timezone, 'UTC') AS timezone,
        CASE
          WHEN stations.used_by_polymarket = 1 THEN 4
          WHEN stations.used_by_interactive_brokers = 1 THEN 3
          WHEN stations.used_by_robinhood = 1 THEN 2
          ELSE 1
        END AS priority
      FROM station_day_raw_metars raw
      JOIN station_raw_ids ids ON ids.id = raw.station_id
      LEFT JOIN stations ON stations.station_code = ids.station_code
      WHERE raw.local_date >= @minLocalDate
        AND raw.local_date <= @maxLocalDate
      ORDER BY priority DESC, raw.local_date DESC, ids.station_code ASC
    `
    )
    .all({ minLocalDate, maxLocalDate })
}

function mergeStationGapRepairWindows(windows: MetarStationGapRepairWindow[]) {
  const merged: MetarStationGapRepairWindow[] = []

  for (const window of [...windows].sort(stationGapRepairWindowSort)) {
    const previous = merged.at(-1)
    if (
      previous &&
      previous.stationCode === window.stationCode &&
      previous.localDate === window.localDate &&
      previous.endDate >= window.startDate
    ) {
      previous.endDate =
        previous.endDate > window.endDate ? previous.endDate : window.endDate
      previous.gapCount += window.gapCount
      continue
    }

    merged.push({ ...window })
  }

  return merged
}

function stationGapRepairWindowSort(
  left: MetarStationGapRepairWindow,
  right: MetarStationGapRepairWindow
) {
  return (
    right.priority - left.priority ||
    left.stationCode.localeCompare(right.stationCode) ||
    left.localDate.localeCompare(right.localDate) ||
    left.startDate.localeCompare(right.startDate) ||
    left.endDate.localeCompare(right.endDate)
  )
}

function floorUtcDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  )
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

function addUtcDays(date: Date, days: number) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function addUtcHours(date: Date, hours: number) {
  const next = new Date(date)
  next.setUTCHours(next.getUTCHours() + hours)
  return next
}

function isAfter(left: Date, right: Date) {
  return left.getTime() > right.getTime()
}

function minDate(left: Date, right: Date) {
  return isAfter(left, right) ? right : left
}

function maxDate(left: Date, right: Date) {
  return isAfter(left, right) ? left : right
}

function formatUtc(date: Date) {
  return date.toISOString().replace(".000Z", "Z")
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10)
}
