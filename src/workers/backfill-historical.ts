import { addDays, format } from "date-fns"

import {
  planChunks,
  runHistoricalBackfill,
} from "../lib/weather/historical-backfill.server"
import { fetchIemAsosNetworks } from "../lib/weather/iem.server"
import {
  planSaoArchiveChunks,
  runSaoArchiveBackfill,
} from "../lib/weather/sao-archive.server"
import { syncStations } from "../lib/weather/ingest.server"
import type { HistoricalBackfillOptions } from "../lib/weather/historical-backfill.server"
import type { IemBackfillScope } from "../lib/weather/iem.server"
import type { SaoArchiveBackfillOptions } from "../lib/weather/sao-archive.server"

type BackfillSource = "auto" | "iem-cgi" | "sao-archive"

type CliOptions = {
  all: boolean
  confirmAll: boolean
  source: BackfillSource
  networks: string[]
  stations: string[]
  startDate: string | null
  endDate: string
  chunkDays: number
  rateLimitMs: number | null
  force: boolean
  dryRun: boolean
  maxRequests: number | null
  maxRetries: number
  retryBaseMs: number | null
  retryMaxMs: number | null
  concurrency: number
  continueOnError: boolean
  oldestFirst: boolean
  stationSync: boolean
  listNetworks: boolean
  reportTypes: string[] | undefined
}

const cli = parseArgs(process.argv.slice(2))

if (cli.listNetworks) {
  const networks = await fetchIemAsosNetworks()
  for (const network of networks) {
    console.log(`${network.id}\t${network.name}`)
  }
  process.exit(0)
}

const backfillScopes = await resolveScopes(cli)

if (backfillScopes.length === 0) {
  printUsage()
  process.exit(1)
}

if (cli.all && cli.stations.length > 0) {
  console.error("Use either --all or --station, not both.")
  process.exit(1)
}

const source = resolveSource(cli, backfillScopes)
const startDate =
  cli.startDate ?? (source === "sao-archive" ? "2000-01-01" : "1900-01-01")
const rateLimitMs = cli.rateLimitMs ?? (source === "sao-archive" ? 0 : 5000)
const retryBaseMs = cli.retryBaseMs ?? (source === "sao-archive" ? 1000 : 30000)
const retryMaxMs = cli.retryMaxMs ?? (source === "sao-archive" ? 30000 : 600000)

if (cli.all && !cli.confirmAll && !cli.dryRun && cli.maxRequests === null) {
  console.error(
    "Refusing global historical backfill without --confirm-all. This can download a large archive."
  )
  process.exit(1)
}

if (source === "sao-archive") {
  const archiveStartDate = clampSaoArchiveStart(startDate)

  if (cli.networks.length > 0) {
    console.error("--source=sao-archive does not support --network.")
    process.exit(1)
  }

  const options: SaoArchiveBackfillOptions = {
    startDate: archiveStartDate,
    endDate: cli.endDate,
    stationCodes: cli.all ? [] : cli.stations,
    concurrency: cli.concurrency,
    rateLimitMs,
    force: cli.force,
    dryRun: cli.dryRun,
    maxRequests: cli.maxRequests,
    maxRetries: cli.maxRetries,
    retryBaseMs,
    retryMaxMs,
    continueOnError: cli.continueOnError,
    newestFirst: !cli.oldestFirst,
  }
  const planned = planSaoArchiveChunks(options)

  if (
    planned.length > 31 &&
    !cli.confirmAll &&
    !cli.dryRun &&
    cli.maxRequests === null
  ) {
    console.error(
      "Refusing large SAO archive backfill without --confirm-all or --max-requests."
    )
    process.exit(1)
  }

  if (cli.stationSync && !cli.dryRun) {
    console.log("Syncing station metadata before SAO archive backfill")
    await syncStations()
  }

  console.log(
    `Historical backfill plan: source=sao-archive days=${planned.length} start=${archiveStartDate} end=${cli.endDate} order=${cli.oldestFirst ? "oldest-first" : "newest-first"} dryRun=${cli.dryRun} concurrency=${cli.concurrency}`
  )

  const summary = await runSaoArchiveBackfill(options, (message) => {
    console.log(`[${new Date().toISOString()}] ${message}`)
  })

  console.log(
    `Historical backfill complete: source=sao-archive planned=${summary.plannedCount} requested=${summary.requestedCount} skippedChunks=${summary.skippedCount} failedChunks=${summary.failedChunkCount} downloadedFiles=${summary.downloadedFileCount} missingFiles=${summary.missingFileCount} failedFiles=${summary.failedFileCount} fetched=${summary.fetchedCount} inserted=${summary.insertedCount} duplicates=${summary.duplicateCount}`
  )
  process.exit(0)
}

const options: HistoricalBackfillOptions = {
  scopes: backfillScopes,
  startDate,
  endDate: cli.endDate,
  chunkDays: cli.chunkDays,
  rateLimitMs,
  force: cli.force,
  dryRun: cli.dryRun,
  maxRequests: cli.maxRequests,
  maxRetries: cli.maxRetries,
  retryBaseMs,
  retryMaxMs,
  reportTypes: cli.reportTypes,
}
const planned = planChunks(options)

console.log(
  `Historical backfill plan: source=iem-cgi scopes=${backfillScopes.length} chunks=${planned.length} start=${startDate} end=${cli.endDate} dryRun=${cli.dryRun}`
)

const summary = await runHistoricalBackfill(options, (message) => {
  console.log(`[${new Date().toISOString()}] ${message}`)
})

console.log(
  `Historical backfill complete: planned=${summary.plannedCount} requested=${summary.requestedCount} skippedChunks=${summary.skippedCount} fetched=${summary.fetchedCount} inserted=${summary.insertedCount} duplicates=${summary.duplicateCount}`
)

async function resolveScopes(
  cliOptions: CliOptions
): Promise<IemBackfillScope[]> {
  const resolvedScopes: IemBackfillScope[] = []

  if (cliOptions.all) {
    resolvedScopes.push({ type: "global", id: "all" })
  }

  for (const network of cliOptions.networks) {
    resolvedScopes.push({ type: "network", id: network.toUpperCase() })
  }

  for (const station of cliOptions.stations) {
    resolvedScopes.push({ type: "station", id: station.toUpperCase() })
  }

  return resolvedScopes
}

function parseArgs(args: string[]): CliOptions {
  const cliOptions: CliOptions = {
    all: false,
    confirmAll: false,
    source: "auto",
    networks: [],
    stations: [],
    startDate: null,
    endDate: format(addDays(new Date(), 1), "yyyy-MM-dd"),
    chunkDays: 31,
    rateLimitMs: null,
    force: false,
    dryRun: false,
    maxRequests: null,
    maxRetries: 8,
    retryBaseMs: null,
    retryMaxMs: null,
    concurrency: 8,
    continueOnError: true,
    oldestFirst: false,
    stationSync: true,
    listNetworks: false,
    reportTypes: undefined,
  }

  for (const arg of args) {
    if (arg === "--all") {
      cliOptions.all = true
    } else if (arg === "--confirm-all") {
      cliOptions.confirmAll = true
    } else if (arg === "--force") {
      cliOptions.force = true
    } else if (arg === "--dry-run") {
      cliOptions.dryRun = true
    } else if (arg === "--list-networks") {
      cliOptions.listNetworks = true
    } else if (arg === "--skip-station-sync") {
      cliOptions.stationSync = false
    } else if (arg === "--stop-on-error") {
      cliOptions.continueOnError = false
    } else if (arg === "--oldest-first") {
      cliOptions.oldestFirst = true
    } else if (arg.startsWith("--source=")) {
      cliOptions.source = sourceArg(arg)
    } else if (arg.startsWith("--network=")) {
      cliOptions.networks.push(...csvArg(arg, "--network="))
    } else if (arg.startsWith("--station=")) {
      cliOptions.stations.push(...csvArg(arg, "--station="))
    } else if (arg.startsWith("--start=")) {
      cliOptions.startDate = arg.slice("--start=".length)
    } else if (arg.startsWith("--end=")) {
      cliOptions.endDate = arg.slice("--end=".length)
    } else if (arg.startsWith("--chunk-days=")) {
      cliOptions.chunkDays = positiveInt(arg, "--chunk-days=")
    } else if (arg.startsWith("--rate-limit-ms=")) {
      cliOptions.rateLimitMs = positiveInt(arg, "--rate-limit-ms=")
    } else if (arg.startsWith("--max-requests=")) {
      cliOptions.maxRequests = positiveInt(arg, "--max-requests=")
    } else if (arg.startsWith("--concurrency=")) {
      cliOptions.concurrency = positiveInt(arg, "--concurrency=")
    } else if (arg.startsWith("--max-retries=")) {
      cliOptions.maxRetries = positiveInt(arg, "--max-retries=")
    } else if (arg.startsWith("--retry-base-ms=")) {
      cliOptions.retryBaseMs = positiveInt(arg, "--retry-base-ms=")
    } else if (arg.startsWith("--retry-max-ms=")) {
      cliOptions.retryMaxMs = positiveInt(arg, "--retry-max-ms=")
    } else if (arg.startsWith("--report-types=")) {
      cliOptions.reportTypes = csvArg(arg, "--report-types=")
    } else if (arg === "--help" || arg === "-h") {
      printUsage()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return cliOptions
}

function resolveSource(
  cliOptions: CliOptions,
  scopes: IemBackfillScope[]
): Exclude<BackfillSource, "auto"> {
  if (cliOptions.source !== "auto") {
    return cliOptions.source
  }

  const onlyGlobal = scopes.length === 1 && scopes[0]?.type === "global"

  return onlyGlobal ? "sao-archive" : "iem-cgi"
}

function csvArg(arg: string, prefix: string) {
  return arg
    .slice(prefix.length)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
}

function positiveInt(arg: string, prefix: string) {
  const value = Number(arg.slice(prefix.length))
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${prefix}${value} must be a positive integer`)
  }

  return value
}

function sourceArg(arg: string): BackfillSource {
  const value = arg.slice("--source=".length)
  if (value === "auto" || value === "iem-cgi" || value === "sao-archive") {
    return value
  }

  throw new Error("--source must be one of auto, iem-cgi, or sao-archive")
}

function clampSaoArchiveStart(date: string) {
  return date < "2000-01-01" ? "2000-01-01" : date
}

function printUsage() {
  console.log(`Usage:
  bun run backfill:historical -- --all --confirm-all
  bun run backfill:historical -- --all --source=sao-archive --confirm-all
  bun run backfill:historical -- --all --dry-run
  bun run backfill:historical -- --network=IA_ASOS --start=2020-01-01 --end=2021-01-01
  bun run backfill:historical -- --station=KDEN --start=2026-05-01 --end=2026-05-02
  bun run backfill:historical -- --list-networks

Options:
  --all                    Backfill all IEM ASOS/METAR stations.
  --confirm-all            Required for a full global backfill unless --dry-run or --max-requests is set.
  --source=auto            auto uses sao-archive for --all and iem-cgi otherwise.
  --network=IA_ASOS        Backfill one or more IEM ASOS networks, comma-separated.
  --station=KDEN           Backfill one or more stations, comma-separated.
  --start=YYYY-MM-DD       Inclusive UTC start date. Defaults to 2000-01-01 for sao-archive and 1900-01-01 for iem-cgi.
  --end=YYYY-MM-DD         Exclusive UTC end date. Defaults to tomorrow.
  --chunk-days=31          Chunk size for network/station scopes. Global --all is always 1 day.
  --rate-limit-ms=5000     Minimum delay between IEM request attempts. sao-archive defaults to 0.
  --concurrency=8          Number of hourly SAO archive files fetched at once per day.
  --oldest-first           Process SAO archive chunks from start to end instead of newest-first.
  --max-requests=10        Stop after N new requests.
  --max-retries=8          Retry throttled/unavailable IEM chunks before failing.
  --retry-base-ms=30000    Initial retry backoff. sao-archive defaults to 1000.
  --retry-max-ms=600000    Maximum retry backoff. sao-archive defaults to 30000.
  --force                  Re-fetch chunks already marked successful.
  --dry-run                Print the plan without downloading data.
  --stop-on-error          Stop SAO archive backfill after a chunk has failed files.
  --skip-station-sync      Do not sync AWC station metadata before sao-archive backfills.
  --report-types=1,3,4     IEM report types: 1 HFMETAR, 3 routine, 4 specials.
`)
}
