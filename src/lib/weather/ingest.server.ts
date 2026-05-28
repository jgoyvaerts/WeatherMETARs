import type Database from "better-sqlite3"

import { AWC_METARS_CACHE_URL, AWC_STATIONS_CACHE_URL } from "./config.server"
import { fetchCurrentMetars, fetchStations } from "./awc.server"
import type { AwcStation } from "./awc.server"
import { getSqlite } from "./db.server"
import { localDateForUtc, timezoneForLocation } from "./dates"
import {
  interactiveBrokersStationSearchText,
  isInteractiveBrokersStationCode,
} from "./interactive-brokers-stations"
import {
  isPolymarketStationCode,
  polymarketStationSearchText,
} from "./polymarket-stations"
import {
  isRobinhoodStationCode,
  robinhoodStationSearchText,
} from "./robinhood-stations"
import { readRawMetarEntries, writeRawMetarEntries } from "./raw-files.server"
import {
  hasRawMetarToken,
  normalizeMetarStationCode,
  normalizeRawMetarText,
} from "./raw-metar.server"
import type { RawMetarEntry } from "./raw-files.server"
import type { MetarObservationInput } from "./types"

export type IngestResult = {
  fetchedCount: number
  insertedCount: number
  skippedCount: number
}

type RawMetarGroup = {
  stationCode: string
  localDate: string
  entries: RawMetarEntry[]
}

export async function syncStations() {
  const stations = await fetchStations()
  return upsertStations(stations)
}

export function upsertStations(stations: AwcStation[], db = getSqlite()) {
  const now = new Date().toISOString()
  const statement = db.prepare(`
    INSERT INTO stations (
      station_code, awc_id, icao_id, iata_id, faa_id, name, state, country,
      lat, lon, elev_m, timezone, search_text, used_by_polymarket,
      used_by_interactive_brokers, used_by_robinhood, created_at, updated_at
    )
    VALUES (
      @stationCode, @awcId, @icaoId, @iataId, @faaId, @name, @state, @country,
      @lat, @lon, @elevM, @timezone, @searchText, @usedByPolymarket,
      @usedByInteractiveBrokers, @usedByRobinhood, @createdAt, @updatedAt
    )
    ON CONFLICT(station_code) DO UPDATE SET
      awc_id = excluded.awc_id,
      icao_id = excluded.icao_id,
      iata_id = excluded.iata_id,
      faa_id = excluded.faa_id,
      name = excluded.name,
      state = excluded.state,
      country = excluded.country,
      lat = excluded.lat,
      lon = excluded.lon,
      elev_m = excluded.elev_m,
      timezone = excluded.timezone,
      search_text = excluded.search_text,
      used_by_polymarket = excluded.used_by_polymarket,
      used_by_interactive_brokers = excluded.used_by_interactive_brokers,
      used_by_robinhood = excluded.used_by_robinhood,
      updated_at = excluded.updated_at
  `)

  const transaction = db.transaction((rows: AwcStation[]) => {
    let count = 0

    for (const station of rows) {
      const stationCode = canonicalStationCode(station)
      if (!stationCode) {
        continue
      }

      const lat = nullableNumber(station.lat)
      const lon = nullableNumber(station.lon)
      statement.run({
        stationCode,
        awcId: cleanString(station.id),
        icaoId: cleanString(station.icaoId),
        iataId: cleanString(station.iataId),
        faaId: cleanString(station.faaId),
        name: cleanString(station.site),
        state: cleanString(station.state),
        country: cleanString(station.country),
        lat,
        lon,
        elevM: nullableNumber(station.elev),
        timezone: timezoneForLocation(lat, lon),
        searchText: stationSearchText(stationCode, station),
        usedByPolymarket: isPolymarketStationCode(stationCode) ? 1 : 0,
        usedByInteractiveBrokers: isInteractiveBrokersStationCode(stationCode)
          ? 1
          : 0,
        usedByRobinhood: isRobinhoodStationCode(stationCode) ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })
      count += 1
    }

    return count
  })

  return transaction(stations)
}

export async function ingestCurrentMetars() {
  const observations = await fetchCurrentMetars()
  return ingestObservations(observations)
}

export function ingestObservations(
  observations: MetarObservationInput[],
  db = getSqlite(),
  source = AWC_METARS_CACHE_URL
): IngestResult {
  const runId = startIngestRun(db, source)

  try {
    const result = insertObservations(observations, db)
    finishIngestRun(db, runId, "success", result)
    return result
  } catch (error) {
    finishIngestRun(
      db,
      runId,
      "error",
      {
        fetchedCount: observations.length,
        insertedCount: 0,
        skippedCount: observations.length,
      },
      error instanceof Error ? error.message : String(error)
    )
    throw error
  }
}

export async function runFullIngest() {
  await ensureStationSyncRun()
  return ingestCurrentMetars()
}

function insertObservations(
  observations: MetarObservationInput[],
  db: Database.Database
) {
  const ensureStation = db.prepare(`
    INSERT INTO stations (
      station_code, lat, lon, elev_m, timezone, search_text,
      used_by_polymarket, used_by_interactive_brokers, used_by_robinhood,
      created_at, updated_at
    )
    VALUES (
      @stationCode, @lat, @lon, @elevM, @timezone, @searchText,
      @usedByPolymarket, @usedByInteractiveBrokers, @usedByRobinhood,
      @createdAt, @updatedAt
    )
    ON CONFLICT(station_code) DO UPDATE SET
      lat = COALESCE(stations.lat, excluded.lat),
      lon = COALESCE(stations.lon, excluded.lon),
      elev_m = COALESCE(stations.elev_m, excluded.elev_m),
      timezone = CASE WHEN stations.timezone = 'UTC' THEN excluded.timezone ELSE stations.timezone END,
      search_text = CASE WHEN stations.search_text = '' THEN excluded.search_text ELSE stations.search_text END,
      used_by_polymarket = excluded.used_by_polymarket,
      used_by_interactive_brokers = excluded.used_by_interactive_brokers,
      used_by_robinhood = excluded.used_by_robinhood,
      updated_at = excluded.updated_at
  `)
  const stationLookup = db.prepare<
    { stationCode: string },
    { timezone: string }
  >(`
    SELECT timezone FROM stations WHERE station_code = @stationCode
  `)

  const transaction = db.transaction((rows: MetarObservationInput[]) => {
    const groups = new Map<string, RawMetarGroup>()
    let invalidCount = 0

    for (const observation of rows) {
      const stationCode = normalizeMetarStationCode(observation.stationCode)
      if (!stationCode) {
        invalidCount += 1
        continue
      }

      const now = new Date().toISOString()
      const fallbackTimezone = timezoneForLocation(
        observation.lat,
        observation.lon
      )
      ensureStation.run({
        stationCode,
        lat: observation.lat,
        lon: observation.lon,
        elevM: observation.elevM,
        timezone: fallbackTimezone,
        searchText: fallbackStationSearchText(stationCode),
        usedByPolymarket: isPolymarketStationCode(stationCode) ? 1 : 0,
        usedByInteractiveBrokers: isInteractiveBrokersStationCode(stationCode)
          ? 1
          : 0,
        usedByRobinhood: isRobinhoodStationCode(stationCode) ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })

      const station = stationLookup.get({
        stationCode,
      })
      const timezone = station?.timezone ?? fallbackTimezone
      const localDate = localDateForUtc(observation.observedAtUtc, timezone)
      const key = `${stationCode}\0${localDate}`
      const group = groups.get(key) ?? {
        stationCode,
        localDate,
        entries: [],
      }

      group.entries.push({
        observedAtUtc: observation.observedAtUtc,
        rawText: normalizeRawMetarText(
          observation.rawText,
          observation.metarType ?? "METAR"
        ),
      })
      groups.set(key, group)
    }

    return { groups: Array.from(groups.values()), invalidCount }
  })
  const { groups, invalidCount } = transaction(observations)

  return mergeRawMetarGroups(groups, {
    fetchedCount: observations.length,
    skippedCount: invalidCount,
  })
}

function mergeRawMetarGroups(
  groups: RawMetarGroup[],
  {
    fetchedCount,
    skippedCount: initialSkippedCount = 0,
  }: { fetchedCount: number; skippedCount?: number }
): IngestResult {
  let insertedCount = 0
  let skippedCount = initialSkippedCount

  for (const group of groups) {
    const byObservedAt = new Map<string, RawMetarEntry>()
    for (const entry of readRawMetarEntries(
      group.stationCode,
      group.localDate
    )) {
      byObservedAt.set(entry.observedAtUtc, entry)
    }

    let changed = false

    for (const entry of group.entries) {
      const existing = byObservedAt.get(entry.observedAtUtc)

      if (!existing) {
        byObservedAt.set(entry.observedAtUtc, entry)
        insertedCount += 1
        changed = true
      } else if (shouldReplaceObservation(entry, existing)) {
        byObservedAt.set(entry.observedAtUtc, entry)
        skippedCount += 1
        changed = true
      } else {
        skippedCount += 1
      }
    }

    const entries = Array.from(byObservedAt.values())
    if (changed) {
      writeRawMetarEntries(group.stationCode, group.localDate, entries)
    }
  }

  return {
    fetchedCount,
    insertedCount,
    skippedCount,
  }
}

function shouldReplaceObservation(
  candidate: RawMetarEntry,
  existing: RawMetarEntry
) {
  const candidateRank = observationQualityRank(candidate)
  const existingRank = observationQualityRank(existing)

  for (const [index, candidateValue] of candidateRank.entries()) {
    const existingValue = existingRank[index]
    if (candidateValue !== existingValue) {
      return candidateValue > existingValue
    }
  }

  return false
}

function observationQualityRank(observation: Pick<RawMetarEntry, "rawText">) {
  const rawText = observation.rawText.trim()

  return [
    hasRawMetarToken(rawText, "MADISHF") ? 0 : 1,
    hasMetarReportPrefix(rawText) ? 1 : 0,
    rawText === rawText.toUpperCase() ? 1 : 0,
    rawText.length,
  ]
}

function hasMetarReportPrefix(rawText: string) {
  const firstToken = rawText.split(/\s+/, 1)[0]?.toUpperCase()
  return firstToken === "METAR" || firstToken === "SPECI"
}

function startIngestRun(db: Database.Database, source: string) {
  const result = db
    .prepare(
      "INSERT INTO ingest_runs (source, started_at, status) VALUES (?, ?, ?)"
    )
    .run(source, new Date().toISOString(), "running")
  return Number(result.lastInsertRowid)
}

function finishIngestRun(
  db: Database.Database,
  runId: number,
  status: string,
  result: IngestResult,
  errorText: string | null = null
) {
  db.prepare(
    `
    UPDATE ingest_runs
    SET finished_at = ?, status = ?, fetched_count = ?, inserted_count = ?,
      skipped_count = ?, error_text = ?
    WHERE id = ?
  `
  ).run(
    new Date().toISOString(),
    status,
    result.fetchedCount,
    result.insertedCount,
    result.skippedCount,
    errorText,
    runId
  )
}

async function ensureStationSyncRun() {
  const db = getSqlite()
  const lastRun = db
    .prepare<{ source: string }, { finishedAt: string | null }>(
      `
      SELECT finished_at AS finishedAt
      FROM ingest_runs
      WHERE source = @source AND status = 'success'
      ORDER BY id DESC
      LIMIT 1
    `
    )
    .get({ source: AWC_STATIONS_CACHE_URL })

  const lastFinished = lastRun?.finishedAt
    ? new Date(lastRun.finishedAt).getTime()
    : 0
  const shouldSync = Date.now() - lastFinished > 24 * 60 * 60 * 1000

  if (!shouldSync) {
    return
  }

  const runId = startIngestRun(db, AWC_STATIONS_CACHE_URL)

  try {
    const count = await syncStations()
    finishIngestRun(db, runId, "success", {
      fetchedCount: count,
      insertedCount: count,
      skippedCount: 0,
    })
  } catch (error) {
    finishIngestRun(
      db,
      runId,
      "error",
      {
        fetchedCount: 0,
        insertedCount: 0,
        skippedCount: 0,
      },
      error instanceof Error ? error.message : String(error)
    )
    throw error
  }
}

function canonicalStationCode(station: AwcStation) {
  return normalizeMetarStationCode(
    station.icaoId ?? station.faaId ?? station.iataId ?? station.id ?? ""
  )
}

function cleanString(value: string | null | undefined) {
  const clean = value?.trim()
  return clean ? clean : null
}

function nullableNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function stationSearchText(stationCode: string, station: AwcStation) {
  return [
    stationCode,
    station.id,
    station.icaoId,
    station.iataId,
    station.faaId,
    station.site,
    station.state,
    station.country,
    polymarketStationSearchText(stationCode),
    interactiveBrokersStationSearchText(stationCode),
    robinhoodStationSearchText(stationCode),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

function fallbackStationSearchText(stationCode: string) {
  return [
    stationCode,
    polymarketStationSearchText(stationCode),
    interactiveBrokersStationSearchText(stationCode),
    robinhoodStationSearchText(stationCode),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}
