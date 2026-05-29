import { POLL_INTERVAL_MS } from "../lib/weather/config.server"
import {
  METAR_DAY_RECONCILE_INTERVAL_MS,
  runMetarDayReconcile,
} from "../lib/weather/day-reconcile.server"
import { runMetarGapRepair } from "../lib/weather/gap-repair.server"
import { runFullIngest } from "../lib/weather/ingest.server"

let stopped = false
let running = false
let interval: NodeJS.Timeout | null = null
let lastDayReconcileStartedAt = 0

process.on("SIGINT", stop)
process.on("SIGTERM", stop)

await poll()

interval = setInterval(() => {
  void poll()
}, POLL_INTERVAL_MS)

function stop() {
  stopped = true
  if (interval) {
    clearInterval(interval)
  }
}

async function poll() {
  if (stopped || running) {
    return
  }

  running = true
  try {
    try {
      const result = await runFullIngest()
      console.log(
        `[${new Date().toISOString()}] METAR poll fetched=${result.fetchedCount} inserted=${result.insertedCount} skipped=${result.skippedCount}`
      )
    } catch (error) {
      console.error(`[${new Date().toISOString()}] METAR poll failed`, error)
    }

    try {
      const repair = await runMetarGapRepair((message) => {
        console.log(`[${new Date().toISOString()}] ${message}`)
      })
      if (
        repair.repairedWindowCount > 0 ||
        repair.skippedNotReadyCount > 0 ||
        repair.skippedWindowCount > 0
      ) {
        console.log(
          `[${new Date().toISOString()}] METAR gap repair checked=${repair.checkedGapCount} planned=${repair.plannedWindowCount} repaired=${repair.repairedWindowCount} skippedNotReady=${repair.skippedNotReadyCount} skippedWindows=${repair.skippedWindowCount} fetched=${repair.fetchedCount} inserted=${repair.insertedCount} duplicates=${repair.duplicateCount} missingFiles=${repair.missingFileCount} failedChunks=${repair.failedChunkCount} failedFiles=${repair.failedFileCount}`
        )
      }
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] METAR gap repair failed`,
        error
      )
    }

    await reconcileDayIfDue()
  } finally {
    running = false
  }
}

async function reconcileDayIfDue() {
  const now = new Date()
  if (
    now.getTime() - lastDayReconcileStartedAt <
    METAR_DAY_RECONCILE_INTERVAL_MS
  ) {
    return
  }

  lastDayReconcileStartedAt = now.getTime()

  try {
    const reconcile = await runMetarDayReconcile((message) => {
      console.log(`[${new Date().toISOString()}] ${message}`)
    })

    if (
      reconcile.reconciledWindowCount > 0 ||
      reconcile.skippedNotReadyCount > 0 ||
      reconcile.skippedWindowCount > 0 ||
      reconcile.repairedStationGapWindowCount > 0 ||
      reconcile.skippedStationGapWindowCount > 0 ||
      reconcile.failedStationGapWindowCount > 0 ||
      reconcile.failedChunkCount > 0 ||
      reconcile.failedFileCount > 0
    ) {
      console.log(
        `[${new Date().toISOString()}] METAR day reconcile checked=${reconcile.checkedWindowCount} planned=${reconcile.plannedWindowCount} reconciled=${reconcile.reconciledWindowCount} skippedCompleted=${reconcile.skippedCompletedWindowCount} skippedNotReady=${reconcile.skippedNotReadyCount} skippedWindows=${reconcile.skippedWindowCount} checkedStationDays=${reconcile.checkedStationDayCount} detectedStationGaps=${reconcile.detectedStationGapCount} plannedStationGapWindows=${reconcile.plannedStationGapWindowCount} repairedStationGapWindows=${reconcile.repairedStationGapWindowCount} skippedStationGapWindows=${reconcile.skippedStationGapWindowCount} failedStationGapWindows=${reconcile.failedStationGapWindowCount} fetched=${reconcile.fetchedCount} inserted=${reconcile.insertedCount} duplicates=${reconcile.duplicateCount} missingFiles=${reconcile.missingFileCount} failedChunks=${reconcile.failedChunkCount} failedFiles=${reconcile.failedFileCount}`
      )
    }
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] METAR day reconcile failed`,
      error
    )
  }
}
