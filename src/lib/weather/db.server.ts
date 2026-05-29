import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import Database from "better-sqlite3"

import { getDbPath } from "./config.server"
import {
  INTERACTIVE_BROKERS_STATIONS,
  interactiveBrokersStationSearchText,
} from "./interactive-brokers-stations"
import {
  POLYMARKET_STATIONS,
  polymarketStationSearchText,
} from "./polymarket-stations"
import {
  ROBINHOOD_STATIONS,
  robinhoodStationSearchText,
} from "./robinhood-stations"

let sqlite: Database.Database | null = null
let migrated = false

const SQLITE_BUSY_TIMEOUT_MS = 30_000
const SQLITE_BUSY_RETRY_MAX_RETRIES = 8
const SQLITE_BUSY_RETRY_BASE_MS = 250
const SQLITE_BUSY_RETRY_MAX_MS = 5_000
const require = createRequire(import.meta.url)

export type SqliteBusyRetryOptions = {
  maxRetries?: number
  retryBaseMs?: number
  retryMaxMs?: number
  onRetry?: (details: {
    attempt: number
    maxRetries: number
    waitMs: number
    error: unknown
  }) => void
}

export function getSqlite() {
  if (!sqlite) {
    const dbPath = getDbPath()
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    sqlite = createSqliteDatabase(dbPath)
    sqlite.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`)
    sqlite.pragma("journal_mode = WAL")
    sqlite.pragma("synchronous = NORMAL")
    sqlite.pragma("foreign_keys = ON")
  }

  if (!migrated) {
    migrateSqlite(sqlite)
    migrated = true
  }

  return sqlite
}

export async function retrySqliteBusy<TResult>(
  operation: () => TResult | Promise<TResult>,
  options: SqliteBusyRetryOptions = {}
) {
  const maxRetries = options.maxRetries ?? SQLITE_BUSY_RETRY_MAX_RETRIES
  const retryBaseMs = options.retryBaseMs ?? SQLITE_BUSY_RETRY_BASE_MS
  const retryMaxMs = options.retryMaxMs ?? SQLITE_BUSY_RETRY_MAX_MS

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= maxRetries) {
        throw error
      }

      const waitMs = sqliteBusyRetryWaitMs(attempt, retryBaseMs, retryMaxMs)
      options.onRetry?.({
        attempt: attempt + 1,
        maxRetries,
        waitMs,
        error,
      })
      await sleep(waitMs)
    }
  }
}

export function isSqliteBusyError(error: unknown) {
  if (!(error instanceof Error)) {
    return false
  }

  const maybeError = error as Error & { code?: unknown }
  if (
    maybeError.code === "SQLITE_BUSY" ||
    maybeError.code === "SQLITE_LOCKED"
  ) {
    return true
  }

  const message = error.message.toLowerCase()
  return (
    message.includes("database is locked") ||
    message.includes("database table is locked") ||
    message.includes("database schema is locked")
  )
}

export function migrateSqlite(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stations (
      station_code TEXT PRIMARY KEY NOT NULL,
      awc_id TEXT,
      icao_id TEXT,
      iata_id TEXT,
      faa_id TEXT,
      name TEXT,
      state TEXT,
      country TEXT,
      lat REAL,
      lon REAL,
      elev_m REAL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      search_text TEXT NOT NULL DEFAULT '',
      used_by_polymarket INTEGER NOT NULL DEFAULT 0,
      used_by_interactive_brokers INTEGER NOT NULL DEFAULT 0,
      used_by_robinhood INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS stations_search_text_idx ON stations(search_text);
    CREATE INDEX IF NOT EXISTS stations_country_idx ON stations(country);
    CREATE INDEX IF NOT EXISTS stations_used_by_polymarket_idx
      ON stations(used_by_polymarket);
    CREATE INDEX IF NOT EXISTS stations_used_by_interactive_brokers_idx
      ON stations(used_by_interactive_brokers);
    CREATE INDEX IF NOT EXISTS stations_used_by_robinhood_idx
      ON stations(used_by_robinhood);

    CREATE TABLE IF NOT EXISTS ingest_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      fetched_count INTEGER NOT NULL DEFAULT 0,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      error_text TEXT
    );

    CREATE INDEX IF NOT EXISTS ingest_runs_source_id_idx
      ON ingest_runs(source, id);

    CREATE TABLE IF NOT EXISTS station_raw_ids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_code TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS station_day_raw_metars (
      station_id INTEGER NOT NULL,
      local_date TEXT NOT NULL,
      payload BLOB NOT NULL,
      PRIMARY KEY(station_id, local_date),
      FOREIGN KEY(station_id) REFERENCES station_raw_ids(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS station_day_raw_metars_local_date_idx
      ON station_day_raw_metars(local_date);

    CREATE TABLE IF NOT EXISTS historical_backfill_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      started_at_utc TEXT NOT NULL,
      ended_at_utc TEXT NOT NULL,
      status TEXT NOT NULL,
      fetched_count INTEGER NOT NULL DEFAULT 0,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      error_text TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS historical_backfill_chunk_scope_idx
      ON historical_backfill_chunks(source, scope_type, scope_id, started_at_utc, ended_at_utc);
    CREATE INDEX IF NOT EXISTS historical_backfill_chunk_status_idx
      ON historical_backfill_chunks(status);
    CREATE INDEX IF NOT EXISTS historical_backfill_chunk_coverage_idx
      ON historical_backfill_chunks(status, started_at_utc, ended_at_utc);
  `)

  seedPolymarketStationFlags(db)
  seedInteractiveBrokersStationFlags(db)
  seedRobinhoodStationFlags(db)
}

function seedPolymarketStationFlags(db: Database.Database) {
  seedSourceStationFlags(db, {
    columnName: "used_by_polymarket",
    searchTextForStation: polymarketStationSearchText,
    stations: POLYMARKET_STATIONS,
  })
}

function seedInteractiveBrokersStationFlags(db: Database.Database) {
  seedSourceStationFlags(db, {
    columnName: "used_by_interactive_brokers",
    searchTextForStation: interactiveBrokersStationSearchText,
    stations: INTERACTIVE_BROKERS_STATIONS,
  })
}

function seedRobinhoodStationFlags(db: Database.Database) {
  seedSourceStationFlags(db, {
    columnName: "used_by_robinhood",
    searchTextForStation: robinhoodStationSearchText,
    stations: ROBINHOOD_STATIONS,
  })
}

type SourceStationFlagColumn =
  | "used_by_polymarket"
  | "used_by_interactive_brokers"
  | "used_by_robinhood"

type SourceStationFlagRow = {
  stationCode: string
  searchText: string
  usedBySource: number
}

type SourceStationFlagUpdate = SourceStationFlagRow

function seedSourceStationFlags(
  db: Database.Database,
  {
    columnName,
    searchTextForStation,
    stations,
  }: {
    columnName: SourceStationFlagColumn
    searchTextForStation: (stationCode: string) => string
    stations: readonly { stationCode: string }[]
  }
) {
  const sourceStationCodes = new Set(
    stations.map((station) => station.stationCode)
  )
  const selectStations = db.prepare<[], SourceStationFlagRow>(
    `
    SELECT station_code AS stationCode,
      search_text AS searchText,
      ${columnName} AS usedBySource
    FROM stations
  `
  )
  const updateStation = db.prepare<SourceStationFlagUpdate>(
    `
    UPDATE stations
    SET ${columnName} = @usedBySource,
      search_text = @searchText
    WHERE station_code = @stationCode
  `
  )

  const updates = selectStations.all().flatMap((row) => {
    const usedBySource = sourceStationCodes.has(row.stationCode) ? 1 : 0
    const searchText =
      usedBySource === 1
        ? mergeSearchText(row.searchText, searchTextForStation(row.stationCode))
        : row.searchText

    return row.usedBySource === usedBySource && row.searchText === searchText
      ? []
      : [{ ...row, searchText, usedBySource }]
  })

  if (updates.length === 0) {
    return
  }

  const transaction = db.transaction(() => {
    for (const update of updates) {
      updateStation.run(update)
    }
  })

  transaction()
}

function mergeSearchText(existing: string, additional: string) {
  return Array.from(
    new Set(
      `${existing} ${additional}`.toLowerCase().split(/\s+/).filter(Boolean)
    )
  ).join(" ")
}

export function closeSqliteForTests() {
  sqlite?.close()
  sqlite = null
  migrated = false
}

function createSqliteDatabase(dbPath: string) {
  if (isBunRuntime()) {
    return new BunSqliteDatabase(dbPath) as unknown as Database.Database
  }

  return new Database(dbPath, { timeout: SQLITE_BUSY_TIMEOUT_MS })
}

function sqliteBusyRetryWaitMs(
  attempt: number,
  retryBaseMs: number,
  retryMaxMs: number
) {
  const exponentialMs = Math.min(
    Math.max(0, retryMaxMs),
    Math.max(0, retryBaseMs) * 2 ** attempt
  )
  const jitterMs = Math.round(
    Math.random() * Math.min(250, exponentialMs * 0.1)
  )

  return exponentialMs + jitterMs
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type BunSqliteModule = {
  Database: new (filename: string) => BunRawDatabase
}

type BunRawDatabase = {
  prepare: (sql: string) => BunRawStatement
  exec: (sql: string) => unknown
  close: () => void
}

type BunRawStatement = {
  run: (...params: unknown[]) => unknown
  get: (...params: unknown[]) => unknown
  all: (...params: unknown[]) => unknown[]
}

class BunSqliteDatabase {
  readonly #db: BunRawDatabase

  constructor(filename: string) {
    const { Database: DatabaseConstructor } =
      require("bun:sqlite") as BunSqliteModule
    this.#db = new DatabaseConstructor(filename)
  }

  prepare(sql: string) {
    return new BunSqliteStatement(this.#db.prepare(sql))
  }

  exec(sql: string) {
    return this.#db.exec(sql)
  }

  pragma(sql: string) {
    return this.#db.exec(`PRAGMA ${sql}`)
  }

  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult
  ) {
    return (...args: TArgs): TResult => {
      this.#db.exec("BEGIN")

      try {
        const result = fn(...args)
        this.#db.exec("COMMIT")
        return result
      } catch (error) {
        this.#db.exec("ROLLBACK")
        throw error
      }
    }
  }

  close() {
    this.#db.close()
  }
}

class BunSqliteStatement {
  readonly #statement: BunRawStatement

  constructor(statement: BunRawStatement) {
    this.#statement = statement
  }

  run(...params: unknown[]) {
    return this.#statement.run(...normalizeBunSqliteParams(params))
  }

  get(...params: unknown[]) {
    return this.#statement.get(...normalizeBunSqliteParams(params))
  }

  all(...params: unknown[]) {
    return this.#statement.all(...normalizeBunSqliteParams(params))
  }
}

function normalizeBunSqliteParams(params: unknown[]) {
  if (params.length !== 1 || !isRecord(params[0])) {
    return params
  }

  return [prefixedSqliteParams(params[0])]
}

function prefixedSqliteParams(params: Record<string, unknown>) {
  const output: Record<string, unknown> = { ...params }

  for (const [key, value] of Object.entries(params)) {
    if (key.startsWith("@") || key.startsWith("$") || key.startsWith(":")) {
      continue
    }

    output[`@${key}`] = value
    output[`$${key}`] = value
    output[`:${key}`] = value
  }

  return output
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isBunRuntime() {
  return Boolean((globalThis as typeof globalThis & { Bun?: unknown }).Bun)
}
