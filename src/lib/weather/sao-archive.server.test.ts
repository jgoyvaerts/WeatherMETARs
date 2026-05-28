import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { IEM_ASOS_REQUEST_URL } from "./config.server"
import { closeSqliteForTests, getSqlite } from "./db.server"
import { rawMetarPath } from "./raw-files.server"
import {
  parseSaoArchiveText,
  planSaoArchiveChunks,
  runSaoArchiveBackfill,
} from "./sao-archive.server"

let tempDir: string
let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "weather-metars-"))
  originalFetch = globalThis.fetch
  process.env.WEATHERMETARS_DB_PATH = path.join(
    tempDir,
    "weather-metars.sqlite"
  )
  process.env.WEATHERMETARS_RAW_DIR = path.join(tempDir, "raw-metars")
})

afterEach(() => {
  closeSqliteForTests()
  globalThis.fetch = originalFetch
  delete process.env.WEATHERMETARS_DB_PATH
  delete process.env.WEATHERMETARS_RAW_DIR
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe("parseSaoArchiveText", () => {
  it("extracts raw METAR reports from SAO bulletins", () => {
    const observations = parseSaoArchiveText({
      chunkStartUtc: "2000-01-02T00:00:00.000Z",
      text: `
\x01
417
SAUS80 KWBC 020000
METAR
KWEY 012350Z 00000KT 5SM -SHSN OVC010 M06/M09 RMK SLP114 NOSPECI
     60000 4/019 8/5// 11033 54000=

094
SAUS80 KWBC 020000
METAR
KCQT 012347Z AUTO VRB04KT 10SM BKN036 OVC055 13/06 A3008 RMK AO2
     SLP187 T01330061 10144 20111 56010 TSNO $=
\x03
`,
    })

    expect(observations).toHaveLength(2)
    expect(observations[0]).toMatchObject({
      stationCode: "KWEY",
      observedAtUtc: "2000-01-01T23:50:00.000Z",
      tempC: -6,
      dewpointC: -9,
      windDirDegrees: 0,
      windSpeedKt: 0,
      visibilityStatuteMi: "5SM",
      seaLevelPressureMb: 1011.4,
      rawText:
        "METAR KWEY 012350Z 00000KT 5SM -SHSN OVC010 M06/M09 RMK SLP114 NOSPECI 60000 4/019 8/5// 11033 54000",
    })
    expect(observations[1]).toMatchObject({
      stationCode: "KCQT",
      observedAtUtc: "2000-01-01T23:47:00.000Z",
      tempC: 13,
      dewpointC: 6,
      windDirDegrees: null,
      windSpeedKt: 4,
      altimeterInHg: 30.08,
      seaLevelPressureMb: 1018.7,
      visibilityStatuteMi: "10SM",
      clouds: [
        { cover: "BKN", baseFtAgl: 3600 },
        { cover: "OVC", baseFtAgl: 5500 },
      ],
    })
  })

  it("supports station filters", () => {
    const observations = parseSaoArchiveText({
      chunkStartUtc: "2000-01-02T00:00:00.000Z",
      stationFilter: new Set(["KWEY"]),
      text: `
SAUS80 KWBC 020000
METAR
KWEY 012350Z 00000KT 5SM OVC010 M06/M09 A3000=
KCQT 012347Z AUTO VRB04KT 10SM BKN036 13/06 A3008=
`,
    })

    expect(observations.map((observation) => observation.stationCode)).toEqual([
      "KWEY",
    ])
  })
})

describe("planSaoArchiveChunks", () => {
  it("plans daily chunks and clamps before the SAO archive start", () => {
    expect(
      planSaoArchiveChunks({
        startDate: "1900-01-01",
        endDate: "2000-01-03",
      })
    ).toEqual([
      {
        scopeId: "all",
        startUtc: "2000-01-01T00:00:00Z",
        endUtc: "2000-01-02T00:00:00Z",
      },
      {
        scopeId: "all",
        startUtc: "2000-01-02T00:00:00Z",
        endUtc: "2000-01-03T00:00:00Z",
      },
    ])
  })

  it("plans sub-day repair chunks when given UTC datetimes", () => {
    expect(
      planSaoArchiveChunks({
        startDate: "2026-05-28T09:15:00.000Z",
        endDate: "2026-05-28T13:45:00.000Z",
        scopeType: "gap-repair",
      })
    ).toEqual([
      {
        scopeType: "gap-repair",
        scopeId: "all",
        startUtc: "2026-05-28T09:15:00Z",
        endUtc: "2026-05-28T13:45:00Z",
      },
    ])
  })

  it("can plan newest archive chunks first", () => {
    expect(
      planSaoArchiveChunks({
        startDate: "2026-05-26",
        endDate: "2026-05-29",
        newestFirst: true,
      })
    ).toEqual([
      {
        scopeId: "all",
        startUtc: "2026-05-28T00:00:00Z",
        endUtc: "2026-05-29T00:00:00Z",
      },
      {
        scopeId: "all",
        startUtc: "2026-05-27T00:00:00Z",
        endUtc: "2026-05-28T00:00:00Z",
      },
      {
        scopeId: "all",
        startUtc: "2026-05-26T00:00:00Z",
        endUtc: "2026-05-27T00:00:00Z",
      },
    ])
  })
})

describe("runSaoArchiveBackfill", () => {
  it("falls back to IEM CGI when all SAO archive files are missing", async () => {
    stubFetch(async (input) => {
      const url = String(input)

      if (url.includes("/archive/raw/sao/")) {
        return new Response("", { status: 404 })
      }

      if (url.startsWith(IEM_ASOS_REQUEST_URL)) {
        return new Response(
          [
            "station,valid,lon,lat,elevation,tmpf,dwpf,drct,sknt,gust,vsby,alti,mslp,wxcodes,skyc1,skyl1,metar",
            "LAX,2026-05-22 12:53,-118.4085,33.9416,38.00,68.00,55.00,260.00,8.00,,10.00,29.92,1013.20,,FEW,2000.00,KLAX 221253Z 26008KT 10SM FEW020 20/13 A2992",
          ].join("\n"),
          { status: 200 }
        )
      }

      return new Response("unexpected url", { status: 500 })
    })

    const progress: string[] = []
    const summary = await runSaoArchiveBackfill(
      {
        startDate: "2026-05-22",
        endDate: "2026-05-23",
        stationCodes: [],
        concurrency: 8,
        rateLimitMs: 0,
        force: true,
        dryRun: false,
        maxRequests: null,
        maxRetries: 0,
        retryBaseMs: 0,
        retryMaxMs: 0,
        continueOnError: true,
      },
      (message) => progress.push(message)
    )
    const db = getSqlite()
    const rawLines = fs
      .readFileSync(rawMetarPath("KLAX", "2026-05-22"), "utf8")
      .trim()
      .split("\n")
    const ingestRun = db
      .prepare("SELECT source FROM ingest_runs ORDER BY id DESC LIMIT 1")
      .get() as { source: string }

    expect(summary).toMatchObject({
      requestedCount: 1,
      fetchedCount: 1,
      insertedCount: 1,
      duplicateCount: 0,
      downloadedFileCount: 0,
      missingFileCount: 24,
      failedChunkCount: 0,
    })
    expect(rawLines).toHaveLength(1)
    expect(rawLines[0]).toContain(
      "KLAX 221253Z 26008KT 10SM FEW020 20/13 A2992"
    )
    expect(ingestRun.source).toBe(IEM_ASOS_REQUEST_URL)
    expect(progress).toContain(
      "SAO archive has no hourly files for 2026-05-22T00:00:00Z -> 2026-05-23T00:00:00Z; falling back to IEM CGI"
    )
    expect(progress.at(-1)).toContain("source=iem-cgi")
  })

  it("skips a completed chunk from raw marker state after SQLite is recreated", async () => {
    stubFetch(async (input) => {
      const url = String(input)

      if (url.includes("/archive/raw/sao/")) {
        return new Response("", { status: 404 })
      }

      if (url.startsWith(IEM_ASOS_REQUEST_URL)) {
        return new Response(
          [
            "station,valid,lon,lat,elevation,tmpf,dwpf,drct,sknt,gust,vsby,alti,mslp,wxcodes,skyc1,skyl1,metar",
            "LAX,2026-05-22 12:53,-118.4085,33.9416,38.00,68.00,55.00,260.00,8.00,,10.00,29.92,1013.20,,FEW,2000.00,KLAX 221253Z 26008KT 10SM FEW020 20/13 A2992",
          ].join("\n"),
          { status: 200 }
        )
      }

      return new Response("unexpected url", { status: 500 })
    })

    const options = {
      startDate: "2026-05-22",
      endDate: "2026-05-23",
      stationCodes: [],
      concurrency: 8,
      rateLimitMs: 0,
      force: true,
      dryRun: false,
      maxRequests: null,
      maxRetries: 0,
      retryBaseMs: 0,
      retryMaxMs: 0,
      continueOnError: true,
    }

    await runSaoArchiveBackfill(options)

    const dbPath = process.env.WEATHERMETARS_DB_PATH as string
    closeSqliteForTests()
    fs.rmSync(dbPath, { force: true })
    fs.rmSync(`${dbPath}-shm`, { force: true })
    fs.rmSync(`${dbPath}-wal`, { force: true })
    stubFetch(async () => new Response("should not fetch", { status: 500 }))

    const progress: string[] = []
    const summary = await runSaoArchiveBackfill(
      { ...options, force: false },
      (message) => progress.push(message)
    )
    const chunk = getSqlite()
      .prepare("SELECT status FROM historical_backfill_chunks LIMIT 1")
      .get() as { status: string }

    expect(summary).toMatchObject({
      requestedCount: 0,
      skippedCount: 1,
    })
    expect(progress).toContain(
      "Skipping completed SAO archive 2026-05-22T00:00:00Z -> 2026-05-23T00:00:00Z (marker)"
    )
    expect(chunk.status).toBe("success")
  })
})

function stubFetch(
  handler: (input: RequestInfo | URL) => Response | Promise<Response>
) {
  globalThis.fetch = async (input) => handler(input)
}
