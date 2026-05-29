import {
  AWC_METARS_CACHE_URL,
  IEM_ASOS_REQUEST_URL,
  IEM_SAO_ARCHIVE_BASE_URL,
} from "./config.server"
import { getSqlite } from "./db.server"
import {
  DATE_PATTERN,
  currentLocalDate,
  localTimeForUtc,
  localTimestampForUtc,
  normalizeDateParam,
  utcRangeForLocalDate,
} from "./dates"
import { predictionMarketUrlsForStationDay } from "./prediction-market-urls.server"
import {
  hasRawMetarToken,
  parseRawMetarObservation,
  preciseTemperaturePairFromRawMetar,
  temperaturePairFromRawMetar,
} from "./raw-metar.server"
import { roundFahrenheitFromC } from "./units"
import { listHistoricalBackfillChunkMarkers } from "./backfill-markers.server"
import { readRawMetarEntries } from "./raw-files.server"
import { findStationDayObservationGaps } from "./station-day-gaps.server"
import type {
  IngestStatus,
  ObservationRow,
  StationDayCoverage,
  StationDayResponse,
  StationSummary,
} from "./types"

const MIN_STATION_DATE = "2000-01-01"

type StationDbRow = {
  stationCode: string
  awcId: string | null
  icaoId: string | null
  iataId: string | null
  faaId: string | null
  name: string | null
  state: string | null
  country: string | null
  lat: number | null
  lon: number | null
  elevM: number | null
  timezone: string
  usedByPolymarket: number
  usedByInteractiveBrokers: number
  usedByRobinhood: number
}

type ObservationDbRow = {
  id: number
  stationCode: string
  observedAtUtc: string
  tempC: number | null
  dewpointC: number | null
  windDirDegrees: number | null
  windSpeedKt: number | null
  windGustKt: number | null
  visibilityStatuteMi: string | null
  altimeterInHg: number | null
  seaLevelPressureMb: number | null
  wxString: string | null
  flightCategory: string | null
  metarType: string | null
  rawText: string
}

type IngestStatusDbRow = {
  finishedAt: string | null
  status: string | null
  fetchedCount: number | null
  insertedCount: number | null
  skippedCount: number | null
}

type HistoricalCoverageChunkRow = {
  source: string
  scopeType: string
  scopeId: string
  startedAtUtc: string
  endedAtUtc: string
  finishedAt: string | null
}

export function searchStationsInDb(query: string, limit = 4): StationSummary[] {
  const normalized = query.trim().toLowerCase()

  if (normalized.length < 1) {
    return []
  }

  const safeLimit = Math.min(Math.max(limit, 1), 4)
  const rows = getSqlite()
    .prepare<
      {
        exact: string
        prefix: string
        contains: string
        candidateLimit: number
      },
      StationDbRow
    >(
      `
      SELECT
        station_code AS stationCode,
        awc_id AS awcId,
        icao_id AS icaoId,
        iata_id AS iataId,
        faa_id AS faaId,
        name,
        state,
        country,
        lat,
        lon,
        elev_m AS elevM,
        timezone,
        used_by_polymarket AS usedByPolymarket,
        used_by_interactive_brokers AS usedByInteractiveBrokers,
        used_by_robinhood AS usedByRobinhood
      FROM stations
      WHERE
        lower(station_code) = @exact
        OR lower(station_code) LIKE @prefix ESCAPE '\\'
        OR search_text LIKE @contains ESCAPE '\\'
      ORDER BY
        used_by_polymarket DESC,
        used_by_interactive_brokers DESC,
        used_by_robinhood DESC,
        CASE
          WHEN lower(station_code) = @exact THEN 0
          WHEN lower(station_code) LIKE @prefix ESCAPE '\\' THEN 1
          WHEN lower(icao_id) = @exact OR lower(faa_id) = @exact THEN 2
          WHEN lower(name) LIKE @prefix ESCAPE '\\' THEN 3
          ELSE 4
        END ASC,
        station_code ASC
      LIMIT @candidateLimit
    `
    )
    .all({
      exact: normalized,
      prefix: `${escapeLike(normalized)}%`,
      contains: `%${escapeLike(normalized)}%`,
      candidateLimit: Math.max(safeLimit * 20, 100),
    })

  return rows
    .sort(
      (left, right) =>
        Number(right.usedByPolymarket) - Number(left.usedByPolymarket) ||
        Number(right.usedByInteractiveBrokers) -
          Number(left.usedByInteractiveBrokers) ||
        Number(right.usedByRobinhood) - Number(left.usedByRobinhood) ||
        stationRank(left, normalized) - stationRank(right, normalized) ||
        left.stationCode.localeCompare(right.stationCode)
    )
    .slice(0, safeLimit)
    .map(stationFromRow)
}

export function getStationDayFromDb(
  stationCode: string,
  date: string | undefined
): StationDayResponse {
  const normalizedCode = stationCode.trim().toUpperCase()
  const station = findStation(normalizedCode)

  if (!station) {
    const maxDate = currentLocalDate("UTC")
    const localDate =
      date && DATE_PATTERN.test(date)
        ? clampDate(date, MIN_STATION_DATE, maxDate)
        : maxDate

    return {
      station: null,
      localDate,
      highTempC: null,
      highTempF: null,
      lowTempC: null,
      lowTempF: null,
      chartPoints: [],
      observations: [],
      ingestStatus: latestIngestStatus(),
      predictionMarketUrls: emptyPredictionMarketUrls(),
      dateNavigation: emptyDateNavigation(maxDate),
      dayCoverage: emptyDayCoverage(),
    }
  }

  const maxDate = currentLocalDate(station.timezone)
  const localDate = clampDate(
    normalizeDateParam(date, station.timezone),
    MIN_STATION_DATE,
    maxDate
  )
  const observations = observationsForStationDay(station, localDate)
  const temps = observations
    .map((observation) => observation.tempC)
    .filter((temp): temp is number => temp !== null && Number.isFinite(temp))
  const tempsF = observations
    .map((observation) => observation.tempF)
    .filter((temp): temp is number => temp !== null && Number.isFinite(temp))

  return {
    station,
    localDate,
    highTempC: temps.length ? Math.max(...temps) : null,
    highTempF: tempsF.length ? Math.max(...tempsF) : null,
    lowTempC: temps.length ? Math.min(...temps) : null,
    lowTempF: tempsF.length ? Math.min(...tempsF) : null,
    chartPoints: observations
      .filter((observation) => observation.tempC !== null)
      .map((observation) => ({
        observedAtUtc: observation.observedAtUtc,
        localTimeLabel: observation.localTimeLabel,
        tempC: observation.tempC as number,
        tempF: observation.tempF,
      })),
    observations,
    ingestStatus: latestIngestStatus(),
    predictionMarketUrls: predictionMarketUrlsForStationDay(
      station.stationCode,
      localDate
    ),
    dateNavigation: emptyDateNavigation(maxDate),
    dayCoverage: dayCoverageForStationDay(
      station,
      localDate,
      maxDate,
      observations
    ),
  }
}

function findStation(stationCode: string) {
  const row = getSqlite()
    .prepare<{ stationCode: string }, StationDbRow>(
      `
      SELECT
        station_code AS stationCode,
        awc_id AS awcId,
        icao_id AS icaoId,
        iata_id AS iataId,
        faa_id AS faaId,
        name,
        state,
        country,
        lat,
        lon,
        elev_m AS elevM,
        timezone,
        used_by_polymarket AS usedByPolymarket,
        used_by_interactive_brokers AS usedByInteractiveBrokers,
        used_by_robinhood AS usedByRobinhood
      FROM stations
      WHERE station_code = @stationCode
    `
    )
    .get({ stationCode })

  return row ? stationFromRow(row) : null
}

function observationsForStationDay(
  station: StationSummary,
  localDate: string
): ObservationRow[] {
  const rows = readRawMetarEntries(station.stationCode, localDate).flatMap(
    (entry, index): ObservationDbRow[] => {
      const parsed = parseRawMetarObservation(entry)
      if (!parsed) {
        return []
      }

      return [
        {
          id: index + 1,
          stationCode: parsed.stationCode,
          observedAtUtc: entry.observedAtUtc,
          tempC: parsed.tempC,
          dewpointC: parsed.dewpointC,
          windDirDegrees: parsed.windDirDegrees,
          windSpeedKt: parsed.windSpeedKt,
          windGustKt: parsed.windGustKt,
          visibilityStatuteMi: parsed.visibilityStatuteMi,
          altimeterInHg: parsed.altimeterInHg,
          seaLevelPressureMb: parsed.seaLevelPressureMb,
          wxString: parsed.wxString,
          flightCategory: parsed.flightCategory,
          metarType: parsed.metarType,
          rawText: parsed.rawText,
        },
      ]
    }
  )

  return rows
    .filter(isDisplayableObservation)
    .map((row) => observationRowForDisplay(row, station))
}

function isDisplayableObservation(row: ObservationDbRow) {
  return !hasRawMetarToken(row.rawText, "MADISHF")
}

function observationRowForDisplay(
  row: ObservationDbRow,
  station: StationSummary
): ObservationRow {
  const rawTemperaturePair = temperaturePairFromRawMetar(row.rawText)
  const preciseTemperaturePair = preciseTemperaturePairFromRawMetar(row.rawText)
  const tempC = rawTemperaturePair ? rawTemperaturePair.temperatureC : row.tempC
  const dewpointC = rawTemperaturePair
    ? rawTemperaturePair.dewpointC
    : row.dewpointC

  return {
    ...row,
    tempC,
    tempF: temperatureFForDisplay(
      preciseTemperaturePair?.temperatureC ?? tempC
    ),
    dewpointC,
    dewpointF: temperatureFForDisplay(
      preciseTemperaturePair?.dewpointC ?? dewpointC
    ),
    observedAtLocal: localTimestampForUtc(row.observedAtUtc, station.timezone),
    localTimeLabel: localTimeForUtc(row.observedAtUtc, station.timezone),
  }
}

function temperatureFForDisplay(valueC: number | null) {
  return valueC === null || !Number.isFinite(valueC)
    ? null
    : roundFahrenheitFromC(valueC)
}

function latestIngestStatus(): IngestStatus | null {
  const row = getSqlite()
    .prepare<{ source: string }, IngestStatusDbRow>(
      `
      SELECT
        finished_at AS finishedAt,
        status,
        fetched_count AS fetchedCount,
        inserted_count AS insertedCount,
        skipped_count AS skippedCount
      FROM ingest_runs
      WHERE source = @source
      ORDER BY id DESC
      LIMIT 1
    `
    )
    .get({ source: AWC_METARS_CACHE_URL })

  return row ?? null
}

function dayCoverageForStationDay(
  station: StationSummary,
  localDate: string,
  currentStationLocalDate: string,
  observations: ObservationRow[]
): StationDayCoverage {
  const { startUtc, endUtc } = utcRangeForLocalDate(localDate, station.timezone)

  if (localDate >= currentStationLocalDate) {
    return {
      status: "current",
      coverageStartedAtUtc: startUtc,
      coverageEndedAtUtc: endUtc,
      completedAt: null,
    }
  }

  const stationIds = stationBackfillIds(station)
  const chunks = historicalCoverageChunks(startUtc, endUtc).filter((chunk) =>
    chunkCoversStation(chunk, station, stationIds)
  )

  if (!utcRangeCovered(startUtc, endUtc, chunks)) {
    return {
      status: "incomplete",
      coverageStartedAtUtc: startUtc,
      coverageEndedAtUtc: endUtc,
      completedAt: null,
    }
  }

  const observationGaps = findStationDayObservationGaps(observations, {
    startUtc,
    endUtc,
  })
  if (observationGaps.length > 0) {
    return {
      status: "incomplete",
      coverageStartedAtUtc: startUtc,
      coverageEndedAtUtc: endUtc,
      completedAt: null,
    }
  }

  return {
    status: "complete",
    coverageStartedAtUtc: startUtc,
    coverageEndedAtUtc: endUtc,
    completedAt: latestFinishedAt(chunks),
  }
}

function historicalCoverageChunks(startUtc: string, endUtc: string) {
  const rows = getSqlite()
    .prepare<{ startUtc: string; endUtc: string }, HistoricalCoverageChunkRow>(
      `
      SELECT
        source,
        scope_type AS scopeType,
        scope_id AS scopeId,
        started_at_utc AS startedAtUtc,
        ended_at_utc AS endedAtUtc,
        finished_at AS finishedAt
      FROM historical_backfill_chunks
      WHERE status = 'success'
        AND ended_at_utc > @startUtc
        AND started_at_utc < @endUtc
      ORDER BY started_at_utc ASC
    `
    )
    .all({ startUtc, endUtc })
  const chunks = new Map<string, HistoricalCoverageChunkRow>()

  for (const row of rows) {
    chunks.set(coverageChunkKey(row), row)
  }

  for (const marker of listHistoricalBackfillChunkMarkers(startUtc, endUtc)) {
    chunks.set(coverageChunkKey(marker), {
      source: marker.source,
      scopeType: marker.scopeType,
      scopeId: marker.scopeId,
      startedAtUtc: marker.startedAtUtc,
      endedAtUtc: marker.endedAtUtc,
      finishedAt: marker.finishedAt,
    })
  }

  return [...chunks.values()].sort((left, right) =>
    left.startedAtUtc.localeCompare(right.startedAtUtc)
  )
}

function coverageChunkKey(chunk: HistoricalCoverageChunkRow) {
  return [
    chunk.source,
    chunk.scopeType,
    chunk.scopeId,
    chunk.startedAtUtc,
    chunk.endedAtUtc,
  ].join("\t")
}

function chunkCoversStation(
  chunk: HistoricalCoverageChunkRow,
  station: StationSummary,
  stationIds: Set<string>
) {
  if (chunk.source === IEM_SAO_ARCHIVE_BASE_URL) {
    return (
      (chunk.scopeType === "sao-archive" || chunk.scopeType === "gap-repair") &&
      scopeCoversStation(chunk.scopeId, stationIds)
    )
  }

  if (chunk.source !== IEM_ASOS_REQUEST_URL) {
    return false
  }

  if (chunk.scopeType === "global" && chunk.scopeId === "all") {
    return true
  }

  if (chunk.scopeType === "station") {
    return stationIds.has(chunk.scopeId.toUpperCase())
  }

  if (chunk.scopeType === "network") {
    return stationNetworkIds(station).has(chunk.scopeId.toUpperCase())
  }

  return false
}

function scopeCoversStation(scopeId: string, stationIds: Set<string>) {
  if (scopeId === "all") {
    return true
  }

  if (!scopeId.startsWith("station:")) {
    return false
  }

  return scopeId
    .slice("station:".length)
    .split(",")
    .map((stationId) => stationId.trim().toUpperCase())
    .some((stationId) => stationIds.has(stationId))
}

function utcRangeCovered(
  startUtc: string,
  endUtc: string,
  chunks: HistoricalCoverageChunkRow[]
) {
  const startMs = new Date(startUtc).getTime()
  const endMs = new Date(endUtc).getTime()
  let coveredUntilMs = startMs

  for (const chunk of chunks) {
    const chunkStartMs = new Date(chunk.startedAtUtc).getTime()
    const chunkEndMs = new Date(chunk.endedAtUtc).getTime()

    if (
      !Number.isFinite(chunkStartMs) ||
      !Number.isFinite(chunkEndMs) ||
      chunkEndMs <= coveredUntilMs
    ) {
      continue
    }

    if (chunkStartMs > coveredUntilMs) {
      return false
    }

    coveredUntilMs = Math.max(coveredUntilMs, Math.min(chunkEndMs, endMs))

    if (coveredUntilMs >= endMs) {
      return true
    }
  }

  return coveredUntilMs >= endMs
}

function latestFinishedAt(chunks: HistoricalCoverageChunkRow[]) {
  return (
    chunks
      .map((chunk) => chunk.finishedAt)
      .filter((finishedAt): finishedAt is string => finishedAt !== null)
      .sort()
      .at(-1) ?? null
  )
}

function stationBackfillIds(station: StationSummary) {
  return new Set(
    [
      station.stationCode,
      station.icaoId,
      station.iataId,
      station.faaId,
      station.stationCode.startsWith("K") && station.stationCode.length === 4
        ? station.stationCode.slice(1)
        : null,
    ]
      .filter((id): id is string => Boolean(id))
      .map((id) => id.toUpperCase())
  )
}

function stationNetworkIds(station: StationSummary) {
  const ids = new Set<string>()
  const country = station.country?.toUpperCase()
  const state = station.state?.toUpperCase()

  if (!country) {
    return ids
  }

  if (country === "US" && state) {
    ids.add(`${state}_ASOS`)
  } else {
    ids.add(`${country}__ASOS`)
    if (state) {
      ids.add(`${country}_${state}_ASOS`)
    }
  }

  return ids
}

function stationFromRow(row: StationDbRow): StationSummary {
  return {
    stationCode: row.stationCode,
    awcId: row.awcId,
    icaoId: row.icaoId,
    iataId: row.iataId,
    faaId: row.faaId,
    name: row.name,
    state: row.state,
    country: row.country,
    lat: row.lat,
    lon: row.lon,
    elevM: row.elevM,
    timezone: row.timezone,
    usedByPolymarket: Boolean(row.usedByPolymarket),
    usedByInteractiveBrokers: Boolean(row.usedByInteractiveBrokers),
    usedByRobinhood: Boolean(row.usedByRobinhood),
  }
}

function stationRank(station: StationDbRow, query: string) {
  const code = station.stationCode.toLowerCase()
  const name = station.name?.toLowerCase() ?? ""

  if (code === query) {
    return 0
  }

  if (code.startsWith(query)) {
    return 1
  }

  if (
    station.icaoId?.toLowerCase() === query ||
    station.faaId?.toLowerCase() === query
  ) {
    return 2
  }

  if (name.startsWith(query)) {
    return 3
  }

  return 4
}

function escapeLike(value: string) {
  return value.replaceAll("%", "\\%").replaceAll("_", "\\_")
}

function emptyPredictionMarketUrls() {
  return {
    polymarket: null,
    interactiveBrokers: null,
    robinhood: null,
  }
}

function emptyDateNavigation(maxDate: string) {
  return {
    minDate: MIN_STATION_DATE,
    maxDate,
  }
}

function emptyDayCoverage(): StationDayCoverage {
  return {
    status: "incomplete",
    coverageStartedAtUtc: null,
    coverageEndedAtUtc: null,
    completedAt: null,
  }
}

function clampDate(value: string, min: string, max: string) {
  if (value < min) {
    return min
  }

  if (value > max) {
    return max
  }

  return value
}
