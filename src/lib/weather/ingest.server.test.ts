import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { writeHistoricalBackfillChunkMarker } from "./backfill-markers.server"
import { closeSqliteForTests, getSqlite } from "./db.server"
import { IEM_SAO_ARCHIVE_BASE_URL } from "./config.server"
import { ingestObservations, upsertStations } from "./ingest.server"
import { normalizeRawMetarText } from "./raw-metar.server"
import { rawMetarPath, readRawMetarEntries } from "./raw-files.server"
import { getStationDayFromDb, searchStationsInDb } from "./weather.server"
import type { AwcStation } from "./awc.server"
import type { MetarObservationInput } from "./types"

let tempDir: string

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "weather-metars-"))
  process.env.WEATHERMETARS_DB_PATH = path.join(
    tempDir,
    "weather-metars.sqlite"
  )
  process.env.WEATHERMETARS_RAW_DIR = path.join(tempDir, "raw-metars")
})

afterEach(() => {
  closeSqliteForTests()
  delete process.env.WEATHERMETARS_DB_PATH
  delete process.env.WEATHERMETARS_RAW_DIR
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe("ingestObservations", () => {
  it("skips observations with unsafe station codes before writing raw files", () => {
    const observation = {
      ...denverObservation("2026-05-28T16:53:00.000Z", 18.3),
      stationCode: "../KDEN",
    }

    expect(ingestObservations([observation])).toMatchObject({
      fetchedCount: 1,
      insertedCount: 0,
      skippedCount: 1,
    })
    expect(fs.existsSync(path.join(tempDir, "raw-metars"))).toBe(false)
  })

  it("dedupes observations and appends raw METAR text once", () => {
    upsertStations([denverStation()])

    const observation = denverObservation("2026-05-28T16:53:00.000Z", 18.3)
    const first = ingestObservations([observation])
    const second = ingestObservations([observation])

    const rawLines = rawTexts("KDEN", "2026-05-28")
    const rawRow = getSqlite()
      .prepare(
        `
        SELECT raw.station_id AS stationId,
          raw.local_date AS localDate,
          raw.payload AS payload
        FROM station_day_raw_metars raw
        JOIN station_raw_ids station ON station.id = raw.station_id
        WHERE station.station_code = 'KDEN'
      `
      )
      .get() as { stationId: number; localDate: string; payload: Uint8Array }

    expect(first).toMatchObject({
      fetchedCount: 1,
      insertedCount: 1,
      skippedCount: 0,
    })
    expect(second).toMatchObject({
      fetchedCount: 1,
      insertedCount: 0,
      skippedCount: 1,
    })
    expect(rawLines).toEqual([observation.rawText])
    expect(rawRow).toMatchObject({
      stationId: expect.any(Number),
      localDate: "2026-05-28",
      payload: expect.any(Uint8Array),
    })
    expect(fs.existsSync(path.join(tempDir, "raw-metars"))).toBe(false)
  })

  it("replaces prefixless historical duplicates with richer current observations", () => {
    upsertStations([denverStation()])

    const observedAtUtc = "2026-05-28T16:53:00.000Z"
    const prefixless = {
      ...denverObservation(observedAtUtc, 18.3),
      flightCategory: null,
      visibilityStatuteMi: "6.21",
      rawText: "KDEN 281653Z 04004KT 10SM SCT040 18/11 A3012",
    }
    const current = {
      ...prefixless,
      flightCategory: "VFR",
      visibilityStatuteMi: "6+",
      rawText: "METAR KDEN 281653Z 04004KT 10SM SCT040 18/11 A3012",
    }

    const first = ingestObservations([prefixless])
    const second = ingestObservations([current])
    const rows = rawTexts("KDEN", "2026-05-28")

    expect(first).toMatchObject({
      fetchedCount: 1,
      insertedCount: 1,
      skippedCount: 0,
    })
    expect(second).toMatchObject({
      fetchedCount: 1,
      insertedCount: 0,
      skippedCount: 1,
    })
    expect(rows).toEqual([current.rawText])
  })

  it("searches stations and computes daily temperature extremes", () => {
    upsertStations([denverStation()])
    ingestObservations([
      denverObservation("2026-05-28T12:53:00.000Z", 12.2),
      denverObservation("2026-05-28T16:53:00.000Z", 18.3),
    ])

    const [result] = searchStationsInDb("denver", 5)
    const stationDay = getStationDayFromDb("KDEN", "2026-05-28")

    expect(result.stationCode).toBe("KDEN")
    expect(stationDay.station?.timezone).toBe("America/Denver")
    expect(stationDay.highTempC).toBe(18)
    expect(stationDay.lowTempC).toBe(12)
    expect(stationDay.chartPoints).toHaveLength(2)
    expect(
      stationDay.observations.map((observation) => observation.localTimeLabel)
    ).toEqual(["06:53", "10:53"])
  })

  it("marks historical station days complete only when backfill chunks cover the local day", () => {
    upsertStations([denverStation()])
    ingestObservations([denverObservation("2020-01-01T18:00:00.000Z", 5)])

    expect(getStationDayFromDb("KDEN", "2020-01-01").dayCoverage).toMatchObject(
      {
        status: "incomplete",
        coverageStartedAtUtc: "2020-01-01T07:00:00.000Z",
        coverageEndedAtUtc: "2020-01-02T07:00:00.000Z",
      }
    )

    insertSuccessfulSaoChunk(
      "2020-01-01T00:00:00Z",
      "2020-01-02T00:00:00Z",
      "2020-01-02T00:01:00.000Z"
    )

    expect(getStationDayFromDb("KDEN", "2020-01-01").dayCoverage.status).toBe(
      "incomplete"
    )

    insertSuccessfulSaoChunk(
      "2020-01-02T00:00:00Z",
      "2020-01-03T00:00:00Z",
      "2020-01-03T00:01:00.000Z"
    )

    expect(getStationDayFromDb("KDEN", "2020-01-01").dayCoverage).toMatchObject(
      {
        status: "complete",
        completedAt: "2020-01-03T00:01:00.000Z",
      }
    )
  })

  it("marks historical station days complete from durable chunk markers", () => {
    upsertStations([denverStation()])
    ingestObservations([denverObservation("2020-01-01T18:00:00.000Z", 5)])

    writeSuccessfulSaoChunkMarker(
      "2020-01-01T00:00:00Z",
      "2020-01-02T00:00:00Z",
      "2020-01-02T00:01:00.000Z"
    )
    writeSuccessfulSaoChunkMarker(
      "2020-01-02T00:00:00Z",
      "2020-01-03T00:00:00Z",
      "2020-01-03T00:01:00.000Z"
    )

    expect(getStationDayFromDb("KDEN", "2020-01-01").dayCoverage).toMatchObject(
      {
        status: "complete",
        completedAt: "2020-01-03T00:01:00.000Z",
      }
    )
  })

  it("caps requested station days at the station current local date", () => {
    upsertStations([denverStation()])
    ingestObservations([
      denverObservation("2020-01-01T18:00:00.000Z", 5),
      denverObservation("2020-01-02T18:00:00.000Z", 6),
      denverObservation("2020-01-03T18:00:00.000Z", 7),
    ])

    const futureStationDay = getStationDayFromDb("KDEN", "9999-01-01")

    expect(futureStationDay.dateNavigation.minDate).toBe("2000-01-01")
    expect(futureStationDay.localDate).toBe(
      futureStationDay.dateNavigation.maxDate
    )
  })

  it("stores MADIS high-frequency reports but hides them from station day display", () => {
    upsertStations([denverStation()])

    const highFrequency = denverObservation(
      "2026-05-28T16:50:00.000Z",
      31.1,
      "KDEN 281650Z AUTO 04004KT 10SM CLR 31/10 A3012 RMK T03110100 MADISHF"
    )
    const routine = denverObservation(
      "2026-05-28T16:53:00.000Z",
      18.3,
      "KDEN 281653Z 04004KT 10SM SCT040 18/11 A3012 RMK AO2"
    )

    ingestObservations([highFrequency, routine])

    const rawLines = rawTexts("KDEN", "2026-05-28")
    const stationDay = getStationDayFromDb("KDEN", "2026-05-28")

    expect(rawLines).toEqual([
      normalizedRaw(highFrequency.rawText),
      normalizedRaw(routine.rawText),
    ])
    expect(stationDay.highTempC).toBe(18)
    expect(stationDay.lowTempC).toBe(18)
    expect(stationDay.chartPoints).toHaveLength(1)
    expect(stationDay.observations).toHaveLength(1)
    expect(stationDay.observations[0]?.rawText).toBe(
      normalizedRaw(routine.rawText)
    )
  })

  it("uses rounded METAR body temperatures for station day display", () => {
    upsertStations([denverStation()])

    const observation = {
      ...denverObservation(
        "2026-05-28T21:53:00.000Z",
        29.4,
        "KDEN 282153Z 22005KT 10SM FEW050 FEW080 FEW110 BKN250 29/17 A2987 RMK AO2 SLP108 T02940172"
      ),
      dewpointC: 17.2,
    }

    ingestObservations([observation])

    const stationDay = getStationDayFromDb("KDEN", "2026-05-28")

    expect(stationDay.highTempC).toBe(29)
    expect(stationDay.highTempF).toBe(85)
    expect(stationDay.lowTempC).toBe(29)
    expect(stationDay.lowTempF).toBe(85)
    expect(stationDay.chartPoints).toEqual([
      expect.objectContaining({ tempC: 29, tempF: 85 }),
    ])
    expect(stationDay.observations).toEqual([
      expect.objectContaining({
        tempC: 29,
        tempF: 85,
        dewpointC: 17,
        dewpointF: 63,
        rawText: normalizedRaw(observation.rawText),
      }),
    ])
  })

  it("uses precise METAR remark temperatures for Fahrenheit display", () => {
    upsertStations([denverStation()])

    const observation = denverObservation(
      "2026-05-28T23:53:00.000Z",
      30.6,
      "KDEN 282353Z 22005KT 10SM FEW050 BKN250 31/19 A2987 RMK AO2 T03060189"
    )

    ingestObservations([observation])

    const stationDay = getStationDayFromDb("KDEN", "2026-05-28")

    expect(stationDay.highTempC).toBe(31)
    expect(stationDay.highTempF).toBe(87)
    expect(stationDay.observations[0]).toEqual(
      expect.objectContaining({
        tempC: 31,
        tempF: 87,
        dewpointC: 19,
        dewpointF: 66,
      })
    )
  })

  it("prefers routine observations over MADIS high-frequency duplicates", () => {
    upsertStations([denverStation()])

    const observedAtUtc = "2026-05-28T16:50:00.000Z"
    const highFrequency = {
      ...denverObservation(
        observedAtUtc,
        31.1,
        "KDEN 281650Z AUTO 04004KT 10SM CLR 31/10 A3012 RMK T03110100 MADISHF"
      ),
      flightCategory: null,
    }
    const routine = {
      ...denverObservation(
        observedAtUtc,
        18.3,
        "KDEN 281650Z 04004KT 10SM SCT040 18/11 A3012 RMK AO2"
      ),
      flightCategory: null,
    }

    const first = ingestObservations([highFrequency])
    const second = ingestObservations([routine])
    const rows = rawTexts("KDEN", "2026-05-28")
    const stationDay = getStationDayFromDb("KDEN", "2026-05-28")

    expect(first.insertedCount).toBe(1)
    expect(second.skippedCount).toBe(1)
    expect(rows).toEqual([normalizedRaw(routine.rawText)])
    expect(stationDay.observations).toHaveLength(1)
    expect(stationDay.observations[0]?.rawText).toBe(
      normalizedRaw(routine.rawText)
    )
  })

  it("prioritizes Polymarket stations and caps autocomplete results", () => {
    upsertStations([
      denverStation(),
      station("KAPA", "Denver Centennial"),
      station("KBKF", "Buckley Space Force Base"),
      station("KBJC", "Denver Metro"),
      station("KCFO", "Denver Front Range"),
      station("KEIK", "Denver Erie"),
      station("KFNL", "Denver Fort Collins"),
    ])

    const results = searchStationsInDb("denver", 8)

    expect(results).toHaveLength(4)
    expect(results[0]).toMatchObject({
      stationCode: "KBKF",
      usedByPolymarket: true,
      usedByInteractiveBrokers: true,
      usedByRobinhood: true,
    })
  })

  it("flags Interactive Brokers and Robinhood stations after Polymarket stations", () => {
    upsertStations([
      station("KORD", "Chicago O'Hare Intl"),
      station("KMDW", "Chicago Midway Intl Airport"),
      station("KCGX", "Chicago Meigs"),
    ])

    const results = searchStationsInDb("chicago", 4)

    expect(results[0]).toMatchObject({
      stationCode: "KORD",
      usedByPolymarket: true,
      usedByInteractiveBrokers: false,
      usedByRobinhood: false,
    })
    expect(results[1]).toMatchObject({
      stationCode: "KMDW",
      usedByPolymarket: false,
      usedByInteractiveBrokers: true,
      usedByRobinhood: true,
    })
  })

  it("does not flag Interactive Brokers-only stations as Robinhood stations", () => {
    upsertStations([station("KMSY", "New Orleans Intl Airport")])

    const [result] = searchStationsInDb("new orleans", 4)

    expect(result).toMatchObject({
      stationCode: "KMSY",
      usedByPolymarket: false,
      usedByInteractiveBrokers: true,
      usedByRobinhood: false,
    })
  })

  it("does not flag Lagos from the Polymarket station seed", () => {
    upsertStations([station("DNMM", "Lagos")])

    const [result] = searchStationsInDb("lagos", 4)

    expect(result).toMatchObject({
      stationCode: "DNMM",
      usedByPolymarket: false,
      usedByInteractiveBrokers: false,
      usedByRobinhood: false,
    })
  })
})

describe("rawMetarPath", () => {
  it("rejects unsafe station codes and invalid local dates", () => {
    expect(() => rawMetarPath("../KDEN", "2026-05-28")).toThrow(
      "Invalid METAR station code"
    )
    expect(() => rawMetarPath("KDEN", "2026-02-30")).toThrow(
      "Invalid METAR local date"
    )
  })

  it("migrates legacy raw files into SQLite and removes them", () => {
    const rawPath = rawMetarPath("KDEN", "2026-05-28")
    fs.mkdirSync(path.dirname(rawPath), { recursive: true })
    fs.writeFileSync(
      rawPath,
      "2026-05-28T16:53:00.000Z\tMETAR KDEN 281653Z 04004KT 10SM SCT040 18/11 A3012\n",
      "utf8"
    )

    expect(rawTexts("KDEN", "2026-05-28")).toEqual([
      "METAR KDEN 281653Z 04004KT 10SM SCT040 18/11 A3012",
    ])
    expect(fs.existsSync(rawPath)).toBe(false)
    expect(
      getSqlite()
        .prepare("SELECT COUNT(*) AS count FROM station_day_raw_metars")
        .get()
    ).toMatchObject({ count: 1 })
  })
})

function denverStation(): AwcStation {
  return station("KDEN", "Denver Intl", "DEN")
}

function station(
  stationCode: string,
  site: string,
  iataId: string | null = null
): AwcStation {
  return {
    id: stationCode,
    icaoId: stationCode,
    iataId,
    faaId: stationCode,
    site,
    lat: 39.8466,
    lon: -104.6562,
    elev: 1656,
    state: "CO",
    country: "US",
  }
}

function denverObservation(
  observedAtUtc: string,
  tempC: number,
  rawText = defaultRawMetar(observedAtUtc, tempC)
): MetarObservationInput {
  return {
    stationCode: "KDEN",
    observedAtUtc,
    lat: 39.8466,
    lon: -104.6562,
    tempC,
    dewpointC: 10.6,
    windDirDegrees: 40,
    windSpeedKt: 4,
    windGustKt: null,
    visibilityStatuteMi: "10+",
    altimeterInHg: 30.12,
    seaLevelPressureMb: 1014.4,
    wxString: null,
    flightCategory: "VFR",
    metarType: "METAR",
    clouds: [{ cover: "SCT", baseFtAgl: 4000 }],
    rawText,
    elevM: 1656,
  }
}

function defaultRawMetar(observedAtUtc: string, tempC: number) {
  const observedAt = new Date(observedAtUtc)
  const day = String(observedAt.getUTCDate()).padStart(2, "0")
  const hour = String(observedAt.getUTCHours()).padStart(2, "0")
  const minute = String(observedAt.getUTCMinutes()).padStart(2, "0")
  const temperature = metarTemperature(tempC)

  return `METAR KDEN ${day}${hour}${minute}Z 04004KT 10SM SCT040 ${temperature}/11 A3012`
}

function metarTemperature(value: number) {
  const rounded = Math.round(value)
  const sign = rounded < 0 ? "M" : ""
  return `${sign}${String(Math.abs(rounded)).padStart(2, "0")}`
}

function rawTexts(stationCode: string, localDate: string) {
  return readRawMetarEntries(stationCode, localDate).map(
    (entry) => entry.rawText
  )
}

function normalizedRaw(rawText: string) {
  return normalizeRawMetarText(rawText)
}

function insertSuccessfulSaoChunk(
  startedAtUtc: string,
  endedAtUtc: string,
  finishedAt: string
) {
  getSqlite()
    .prepare(
      `
      INSERT INTO historical_backfill_chunks (
        source, scope_type, scope_id, started_at_utc, ended_at_utc, status,
        fetched_count, inserted_count, skipped_count, created_at, finished_at
      )
      VALUES (
        @source, 'sao-archive', 'all', @startedAtUtc, @endedAtUtc, 'success',
        1, 1, 0, @finishedAt, @finishedAt
      )
    `
    )
    .run({
      source: IEM_SAO_ARCHIVE_BASE_URL,
      startedAtUtc,
      endedAtUtc,
      finishedAt,
    })
}

function writeSuccessfulSaoChunkMarker(
  startedAtUtc: string,
  endedAtUtc: string,
  finishedAt: string
) {
  writeHistoricalBackfillChunkMarker({
    source: IEM_SAO_ARCHIVE_BASE_URL,
    scopeType: "sao-archive",
    scopeId: "all",
    startedAtUtc,
    endedAtUtc,
    version: 1,
    status: "success",
    fetchedCount: 1,
    insertedCount: 1,
    skippedCount: 0,
    errorText: null,
    createdAt: finishedAt,
    finishedAt,
  })
}
