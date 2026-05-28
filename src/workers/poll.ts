import { POLL_INTERVAL_MS } from "../lib/weather/config.server"
import { runMetarGapRepair } from "../lib/weather/gap-repair.server"
import { runFullIngest } from "../lib/weather/ingest.server"

let stopped = false
let running = false
let interval: NodeJS.Timeout | null = null

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
  } finally {
    running = false
  }
}
