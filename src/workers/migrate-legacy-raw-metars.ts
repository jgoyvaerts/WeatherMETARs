import { migrateLegacyRawMetarFiles } from "../lib/weather/raw-files.server"
import type { LegacyRawMetarMigrationOptions } from "../lib/weather/raw-files.server"

type CliOptions = {
  dryRun: boolean
  deleteFiles: boolean
  keepFiles: boolean
  maxFiles: number | null
}

const cli = parseArgs(process.argv.slice(2))

if (cli.dryRun && cli.deleteFiles) {
  console.error("Use either --dry-run or --delete-files, not both.")
  process.exit(1)
}

if (!cli.dryRun && !cli.deleteFiles && !cli.keepFiles) {
  console.error(
    "Refusing to run without an explicit mode. Use --dry-run, --delete-files, or --keep-files."
  )
  printUsage()
  process.exit(1)
}

const options: LegacyRawMetarMigrationOptions = {
  deleteFiles: cli.deleteFiles,
  dryRun: cli.dryRun,
  maxFiles: cli.maxFiles,
  onProgress: (message) => {
    console.log(`[${new Date().toISOString()}] ${message}`)
  },
}

const summary = migrateLegacyRawMetarFiles(options)

console.log(
  `Legacy raw METAR migration complete: scanned=${summary.scannedFileCount} migrated=${summary.migratedFileCount} deleted=${summary.deletedFileCount} skipped=${summary.skippedFileCount} entries=${summary.importedEntryCount} dryRun=${cli.dryRun} deleteFiles=${cli.deleteFiles}`
)

function parseArgs(args: string[]): CliOptions {
  const parsed: CliOptions = {
    dryRun: false,
    deleteFiles: false,
    keepFiles: false,
    maxFiles: null,
  }

  for (const arg of args) {
    if (arg === "--dry-run") {
      parsed.dryRun = true
      continue
    }

    if (arg === "--delete-files") {
      parsed.deleteFiles = true
      continue
    }

    if (arg === "--keep-files") {
      parsed.keepFiles = true
      continue
    }

    if (arg.startsWith("--max-files=")) {
      const value = Number(arg.slice("--max-files=".length))
      if (!Number.isInteger(value) || value < 1) {
        console.error("--max-files must be a positive integer.")
        process.exit(1)
      }

      parsed.maxFiles = value
      continue
    }

    console.error(`Unknown option: ${arg}`)
    printUsage()
    process.exit(1)
  }

  return parsed
}

function printUsage() {
  console.error(`
Usage:
  bun run migrate:legacy-raw -- --dry-run [--max-files=1000]
  bun run migrate:legacy-raw -- --delete-files [--max-files=1000]
  bun run migrate:legacy-raw -- --keep-files [--max-files=1000]

Options:
  --dry-run       Scan and parse legacy files without writing SQLite or deleting files.
  --delete-files  Import legacy files into SQLite and remove each file after successful import.
  --keep-files    Import legacy files into SQLite and leave the old files in place.
`)
}
