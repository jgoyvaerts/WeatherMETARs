import { runFullIngest } from "../lib/weather/ingest.server"

const result = await runFullIngest()

console.log(
  `Ingest complete: fetched=${result.fetchedCount} inserted=${result.insertedCount} skipped=${result.skippedCount}`
)
