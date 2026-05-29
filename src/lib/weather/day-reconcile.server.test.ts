import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  planMetarDayReconcileWindows,
  planMetarStationGapRepairWindows,
} from "./day-reconcile.server"
import { closeSqliteForTests, getSqlite } from "./db.server"
import { ingestObservations, upsertStations } from "./ingest.server"
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

describe("planMetarDayReconcileWindows", () => {
  it("plans archive-ready hourly windows from yesterday through today", () => {
    const plan = planMetarDayReconcileWindows({
      now: new Date("2026-05-29T03:30:00.000Z"),
      lookbackDays: 1,
      archiveReadyDelayMs: 60 * 60 * 1000,
    })

    expect(plan.skippedNotReadyCount).toBe(0)
    expect(plan.windows).toHaveLength(26)
    expect(plan.windows[0]).toEqual({
      startDate: "2026-05-28T00:00:00Z",
      endDate: "2026-05-28T01:00:00Z",
    })
    expect(plan.windows.at(-1)).toEqual({
      startDate: "2026-05-29T01:00:00Z",
      endDate: "2026-05-29T02:00:00Z",
    })
  })

  it("keeps the previous UTC day in scope long enough to close it out", () => {
    const plan = planMetarDayReconcileWindows({
      now: new Date("2026-05-29T01:30:00.000Z"),
      lookbackDays: 1,
      archiveReadyDelayMs: 60 * 60 * 1000,
    })

    expect(plan.windows.at(-1)).toEqual({
      startDate: "2026-05-28T23:00:00Z",
      endDate: "2026-05-29T00:00:00Z",
    })
  })

  it("waits until at least one current-day archive hour is ready", () => {
    expect(
      planMetarDayReconcileWindows({
        now: new Date("2026-05-29T00:30:00.000Z"),
        lookbackDays: 0,
        archiveReadyDelayMs: 60 * 60 * 1000,
      })
    ).toEqual({
      windows: [],
      skippedNotReadyCount: 1,
    })
  })
})

describe("planMetarStationGapRepairWindows", () => {
  it("groups multiple gaps for one station local day into one IEM request", () => {
    upsertStations([taipeiStation()])
    ingestObservations(
      halfHourlyTaipeiObservations(
        "2026-05-28T22:00:00.000Z",
        "2026-05-29T12:00:00.000Z"
      )
    )

    expect(
      planMetarStationGapRepairWindows({
        db: getSqlite(),
        now: new Date("2026-05-29T21:00:00.000Z"),
        lookbackDays: 1,
        archiveReadyDelayMs: 60 * 60 * 1000,
      }).windows
    ).toEqual([
      expect.objectContaining({
        stationCode: "RCSS",
        localDate: "2026-05-29",
        startDate: "2026-05-28T16:00:00Z",
        endDate: "2026-05-29T16:00:00Z",
        gapCount: 2,
      }),
    ])
  })
})

function taipeiStation(): AwcStation {
  return {
    id: "RCSS",
    icaoId: "RCSS",
    iataId: "TSA",
    faaId: null,
    site: "Taipei Songshan",
    lat: 25.0694,
    lon: 121.5525,
    elev: 5,
    state: null,
    country: "TW",
  }
}

function halfHourlyTaipeiObservations(startUtc: string, endUtc: string) {
  const observations: MetarObservationInput[] = []
  const cursor = new Date(startUtc)
  const end = new Date(endUtc)

  while (cursor <= end) {
    observations.push(taipeiObservation(cursor.toISOString()))
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 30)
  }

  return observations
}

function taipeiObservation(observedAtUtc: string): MetarObservationInput {
  const observedAt = new Date(observedAtUtc)
  const time = `${String(observedAt.getUTCDate()).padStart(2, "0")}${String(
    observedAt.getUTCHours()
  ).padStart(2, "0")}${String(observedAt.getUTCMinutes()).padStart(2, "0")}`

  return {
    stationCode: "RCSS",
    observedAtUtc,
    lat: 25.0694,
    lon: 121.5525,
    tempC: 20,
    dewpointC: 10,
    windDirDegrees: 0,
    windSpeedKt: 0,
    windGustKt: null,
    visibilityStatuteMi: "10",
    altimeterInHg: 29.94,
    seaLevelPressureMb: null,
    wxString: null,
    flightCategory: "VFR",
    metarType: "METAR",
    clouds: [],
    rawText: `METAR RCSS ${time}Z 00000KT 10SM CLR 20/10 Q1014`,
    elevM: 5,
  }
}
