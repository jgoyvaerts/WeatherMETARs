const DEFAULT_ARCHIVE_READY_DELAY_MS = 60 * 60 * 1000
const DEFAULT_LOOKBACK_DAYS = 1
const DEFAULT_MAX_WINDOWS_PER_RUN = 48
const DEFAULT_CONCURRENCY = 8
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_BASE_MS = 1000
const DEFAULT_RETRY_MAX_MS = 30_000

export const METAR_DAY_RECONCILE_INTERVAL_MS = 60 * 60 * 1000

export type MetarDayReconcileWindow = {
  startDate: string
  endDate: string
}

export type MetarDayReconcileRunSummary = {
  checkedWindowCount: number
  plannedWindowCount: number
  reconciledWindowCount: number
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

export type MetarDayReconcileOptions = {
  now?: Date
  enabled?: boolean
  lookbackDays?: number
  archiveReadyDelayMs?: number
  maxWindowsPerRun?: number
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

  summary.checkedWindowCount = plan.windows.length
  summary.plannedWindowCount = plan.windows.length
  summary.skippedNotReadyCount = plan.skippedNotReadyCount
  summary.skippedWindowCount = Math.max(0, plan.windows.length - windows.length)

  if (windows.length === 0) {
    return summary
  }

  const { runSaoArchiveBackfill } = await import("./sao-archive.server")

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

function resolveOptions(options: MetarDayReconcileOptions) {
  return {
    now: options.now ?? new Date(),
    enabled: options.enabled ?? process.env.METAR_DAY_RECONCILE_ENABLED !== "0",
    lookbackDays: Math.max(0, options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS),
    archiveReadyDelayMs:
      options.archiveReadyDelayMs ?? DEFAULT_ARCHIVE_READY_DELAY_MS,
    maxWindowsPerRun: Math.max(
      1,
      options.maxWindowsPerRun ?? DEFAULT_MAX_WINDOWS_PER_RUN
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

function formatUtc(date: Date) {
  return date.toISOString().replace(".000Z", "Z")
}
