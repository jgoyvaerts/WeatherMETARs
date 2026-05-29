import fs from "node:fs"
import type { Dirent } from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import type Database from "better-sqlite3"

import { getRawMetarsDir } from "./config.server"
import { getSqlite } from "./db.server"
import { normalizeMetarStationCode } from "./raw-metar.server"

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export type RawMetarAppend = {
  stationCode: string
  localDate: string
  observedAtUtc: string
  rawText: string
}

export type RawMetarEntry = {
  observedAtUtc: string
  rawText: string
}

export type LegacyRawMetarMigrationOptions = {
  deleteFiles?: boolean
  dryRun?: boolean
  maxFiles?: number | null
  onProgress?: (message: string) => void
}

export type LegacyRawMetarMigrationSummary = {
  scannedFileCount: number
  migratedFileCount: number
  deletedFileCount: number
  skippedFileCount: number
  importedEntryCount: number
}

export function rawMetarPath(stationCode: string, localDate: string) {
  const normalizedStationCode = normalizeRawMetarStationCode(stationCode)
  const normalizedLocalDate = normalizeRawMetarLocalDateOrThrow(localDate)

  const [year, month] = normalizedLocalDate.split("-")
  return path.join(
    getRawMetarsDir(),
    normalizedStationCode,
    year,
    month,
    `${normalizedLocalDate}.txt`
  )
}

export function normalizeRawMetarLocalDate(localDate: string) {
  const normalized = localDate.trim()
  if (!LOCAL_DATE_PATTERN.test(normalized)) {
    return null
  }

  const date = new Date(`${normalized}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === normalized
    ? normalized
    : null
}

export function readRawMetarEntries(
  stationCode: string,
  localDate: string
): RawMetarEntry[] {
  const normalizedStationCode = normalizeRawMetarStationCode(stationCode)
  const normalizedLocalDate = normalizeRawMetarLocalDateOrThrow(localDate)
  const db = getSqlite()

  const stationId = findStationRawId(db, normalizedStationCode)
  if (stationId === null) {
    return []
  }

  const row = db
    .prepare<[number, string], { payload: Buffer | Uint8Array }>(
      `
      SELECT payload
      FROM station_day_raw_metars
      WHERE station_id = ? AND local_date = ?
    `
    )
    .get(stationId, normalizedLocalDate)

  return row ? decodeRawMetarPayload(row.payload, normalizedLocalDate) : []
}

export function writeRawMetarEntries(
  stationCode: string,
  localDate: string,
  entries: RawMetarEntry[]
) {
  const normalizedStationCode = normalizeRawMetarStationCode(stationCode)
  const normalizedLocalDate = normalizeRawMetarLocalDateOrThrow(localDate)
  const db = getSqlite()

  if (entries.length === 0) {
    const stationId = findStationRawId(db, normalizedStationCode)
    if (stationId === null) {
      return
    }

    db.prepare<[number, string]>(
      `
      DELETE FROM station_day_raw_metars
      WHERE station_id = ? AND local_date = ?
    `
    ).run(stationId, normalizedLocalDate)
    return
  }

  const stationId = ensureStationRawId(db, normalizedStationCode)
  db.prepare<{
    stationId: number
    localDate: string
    payload: Buffer
  }>(
    `
    INSERT INTO station_day_raw_metars (station_id, local_date, payload)
    VALUES (@stationId, @localDate, @payload)
    ON CONFLICT(station_id, local_date) DO UPDATE SET payload = excluded.payload
  `
  ).run({
    stationId,
    localDate: normalizedLocalDate,
    payload: encodeRawMetarPayload(entries),
  })
}

export function appendRawMetars(appends: RawMetarAppend[]) {
  const entriesByStationDay = new Map<
    string,
    { stationCode: string; localDate: string; entries: RawMetarEntry[] }
  >()

  for (const append of appends) {
    const stationCode = normalizeRawMetarStationCode(append.stationCode)
    const localDate = normalizeRawMetarLocalDateOrThrow(append.localDate)
    const key = `${stationCode}\t${localDate}`
    const group = entriesByStationDay.get(key) ?? {
      stationCode,
      localDate,
      entries: [],
    }
    group.entries.push({
      observedAtUtc: append.observedAtUtc,
      rawText: append.rawText,
    })
    entriesByStationDay.set(key, group)
  }

  for (const {
    stationCode,
    localDate,
    entries,
  } of entriesByStationDay.values()) {
    writeRawMetarEntries(stationCode, localDate, [
      ...readRawMetarEntries(stationCode, localDate),
      ...entries,
    ])
  }
}

export function migrateLegacyRawMetarFiles({
  deleteFiles = false,
  dryRun = false,
  maxFiles = null,
  onProgress = () => {},
}: LegacyRawMetarMigrationOptions = {}): LegacyRawMetarMigrationSummary {
  const rawDir = getRawMetarsDir()
  const summary: LegacyRawMetarMigrationSummary = {
    scannedFileCount: 0,
    migratedFileCount: 0,
    deletedFileCount: 0,
    skippedFileCount: 0,
    importedEntryCount: 0,
  }

  if (!fs.existsSync(rawDir)) {
    onProgress(`Legacy raw METAR directory does not exist: ${rawDir}`)
    return summary
  }

  const db = dryRun ? null : getSqlite()

  for (const legacyFile of legacyRawMetarFiles(rawDir)) {
    if (maxFiles !== null && summary.scannedFileCount >= maxFiles) {
      break
    }

    summary.scannedFileCount += 1

    const legacyKey = legacyRawMetarFileKey(rawDir, legacyFile)
    if (!legacyKey) {
      summary.skippedFileCount += 1
      continue
    }

    const legacyEntries = readExistingLegacyRawMetarEntries(
      legacyFile,
      legacyKey.localDate
    )
    if (!legacyEntries) {
      summary.skippedFileCount += 1
      continue
    }

    if (legacyEntries.length > 0) {
      if (!dryRun && db) {
        mergeRawMetarEntriesIntoDb(
          db,
          legacyKey.stationCode,
          legacyKey.localDate,
          legacyEntries
        )
      }

      summary.migratedFileCount += 1
      summary.importedEntryCount += legacyEntries.length
    }

    if (deleteFiles && !dryRun) {
      fs.rmSync(legacyFile, { force: true })
      summary.deletedFileCount += 1
    }

    if (summary.scannedFileCount % 1000 === 0) {
      onProgress(
        `Legacy raw METAR migration scanned=${summary.scannedFileCount} migrated=${summary.migratedFileCount} deleted=${summary.deletedFileCount} skipped=${summary.skippedFileCount} entries=${summary.importedEntryCount}`
      )
    }
  }

  if (deleteFiles && !dryRun) {
    removeEmptyLegacyRawDirectories(rawDir)
  }

  return summary
}

function* legacyRawMetarFiles(rawDir: string): Generator<string> {
  let entries: Dirent[]
  try {
    entries = fs.readdirSync(rawDir, { withFileTypes: true })
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return
    }

    throw error
  }

  for (const entry of entries) {
    const entryPath = path.join(rawDir, entry.name)
    if (entry.isDirectory()) {
      yield* legacyRawMetarFiles(entryPath)
    } else if (entry.isFile() && entry.name.endsWith(".txt")) {
      yield entryPath
    }
  }
}

function legacyRawMetarFileKey(rawDir: string, filePath: string) {
  const relativeParts = path.relative(rawDir, filePath).split(path.sep)
  const [stationCodeText] = relativeParts
  const fileName = relativeParts.at(-1) ?? ""
  const localDateText = fileName.endsWith(".txt") ? fileName.slice(0, -4) : ""

  const stationCode = stationCodeText
    ? normalizeMetarStationCode(stationCodeText)
    : null
  const localDate = normalizeRawMetarLocalDate(localDateText)

  if (!stationCode || !localDate) {
    return null
  }

  return {
    stationCode,
    localDate,
  }
}

function readLegacyRawMetarEntries(filePath: string, localDate: string) {
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .flatMap((line) => parseRawMetarLine(line, localDate))
}

function readExistingLegacyRawMetarEntries(
  filePath: string,
  localDate: string
) {
  try {
    return readLegacyRawMetarEntries(filePath, localDate)
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null
    }

    throw error
  }
}

function mergeRawMetarEntriesIntoDb(
  db: Database.Database,
  stationCode: string,
  localDate: string,
  entries: RawMetarEntry[]
) {
  const stationId = ensureStationRawId(db, stationCode)
  const existingRow = db
    .prepare<[number, string], { payload: Buffer | Uint8Array }>(
      `
      SELECT payload
      FROM station_day_raw_metars
      WHERE station_id = ? AND local_date = ?
    `
    )
    .get(stationId, localDate)
  const byObservedAt = new Map<string, RawMetarEntry>()

  for (const entry of existingRow
    ? decodeRawMetarPayload(existingRow.payload, localDate)
    : []) {
    byObservedAt.set(entry.observedAtUtc, entry)
  }

  for (const entry of entries) {
    byObservedAt.set(entry.observedAtUtc, entry)
  }

  db.prepare<{
    stationId: number
    localDate: string
    payload: Buffer
  }>(
    `
    INSERT INTO station_day_raw_metars (station_id, local_date, payload)
    VALUES (@stationId, @localDate, @payload)
    ON CONFLICT(station_id, local_date) DO UPDATE SET payload = excluded.payload
  `
  ).run({
    stationId,
    localDate,
    payload: encodeRawMetarPayload(Array.from(byObservedAt.values())),
  })
}

function removeEmptyLegacyRawDirectories(rawDir: string) {
  const directories: string[] = []

  collectLegacyRawDirectories(rawDir, directories)

  for (const directory of directories.sort(
    (left, right) => right.length - left.length
  )) {
    try {
      fs.rmdirSync(directory)
    } catch {
      // Directory still has non-METAR files or was removed by another process.
    }
  }
}

function collectLegacyRawDirectories(directory: string, output: string[]) {
  if (!fs.existsSync(directory)) {
    return
  }

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      collectLegacyRawDirectories(path.join(directory, entry.name), output)
    }
  }

  output.push(directory)
}

function findStationRawId(db: Database.Database, stationCode: string) {
  const row = db
    .prepare<[string], { id: number }>(
      `
      SELECT id
      FROM station_raw_ids
      WHERE station_code = ?
    `
    )
    .get(stationCode)

  return row?.id ?? null
}

function ensureStationRawId(db: Database.Database, stationCode: string) {
  db.prepare<[string]>(
    `
    INSERT OR IGNORE INTO station_raw_ids (station_code)
    VALUES (?)
  `
  ).run(stationCode)

  const stationId = findStationRawId(db, stationCode)
  if (stationId === null) {
    throw new Error(`Failed to create raw METAR station id for ${stationCode}`)
  }

  return stationId
}

function encodeRawMetarPayload(entries: RawMetarEntry[]) {
  const sortedEntries = [...entries].sort((left, right) =>
    left.observedAtUtc.localeCompare(right.observedAtUtc)
  )
  const text =
    sortedEntries.length === 0
      ? ""
      : `${sortedEntries.map(formatRawMetarLine).join("\n")}\n`

  return zlib.gzipSync(Buffer.from(text, "utf8"))
}

function decodeRawMetarPayload(
  payload: Buffer | Uint8Array,
  localDate: string
) {
  return zlib
    .gunzipSync(Buffer.from(payload))
    .toString("utf8")
    .split("\n")
    .flatMap((line) => parseRawMetarLine(line, localDate))
}

function formatRawMetarLine(entry: RawMetarEntry) {
  return `${entry.observedAtUtc}\t${entry.rawText.trim()}`
}

function normalizeRawMetarStationCode(stationCode: string) {
  const normalizedStationCode = normalizeMetarStationCode(stationCode)
  if (!normalizedStationCode) {
    throw new Error(`Invalid METAR station code: ${stationCode}`)
  }

  return normalizedStationCode
}

function normalizeRawMetarLocalDateOrThrow(localDate: string) {
  const normalizedLocalDate = normalizeRawMetarLocalDate(localDate)
  if (!normalizedLocalDate) {
    throw new Error(`Invalid METAR local date: ${localDate}`)
  }

  return normalizedLocalDate
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function parseRawMetarLine(line: string, localDate: string) {
  const trimmed = line.trim()
  if (!trimmed) {
    return []
  }

  const separatorIndex = trimmed.indexOf("\t")
  if (separatorIndex > 0) {
    const observedAtUtc = trimmed.slice(0, separatorIndex)
    const rawText = trimmed.slice(separatorIndex + 1).trim()

    if (isIsoUtcTimestamp(observedAtUtc) && rawText) {
      return [{ observedAtUtc, rawText }]
    }
  }

  const observedAtUtc = inferObservedAtUtc(trimmed, localDate)
  return observedAtUtc ? [{ observedAtUtc, rawText: trimmed }] : []
}

function isIsoUtcTimestamp(value: string) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

function inferObservedAtUtc(rawText: string, localDate: string) {
  const match = rawText.match(/(?:^|\s)(\d{2})(\d{2})(\d{2})Z(?=\s|$)/)
  if (!match) {
    return null
  }

  const [, dayText, hourText, minuteText] = match
  const reportDay = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const base = new Date(`${localDate}T00:00:00.000Z`)

  if (
    !Number.isFinite(base.getTime()) ||
    !Number.isFinite(reportDay) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    return null
  }

  for (const offsetDays of [-1, 0, 1]) {
    const candidate = new Date(base)
    candidate.setUTCDate(candidate.getUTCDate() + offsetDays)

    if (candidate.getUTCDate() !== reportDay) {
      continue
    }

    candidate.setUTCHours(hour, minute, 0, 0)
    return candidate.toISOString()
  }

  return null
}
