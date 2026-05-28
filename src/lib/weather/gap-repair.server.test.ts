import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { AWC_METARS_CACHE_URL } from "./config.server"
import { closeSqliteForTests, getSqlite } from "./db.server"
import {
  findCurrentIngestGaps,
  planMetarGapRepairWindows,
} from "./gap-repair.server"

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

describe("findCurrentIngestGaps", () => {
  it("finds closed and open gaps between successful current METAR ingests", () => {
    insertCurrentIngestSuccess("2026-05-28T10:00:00.000Z")
    insertCurrentIngestSuccess("2026-05-28T12:30:00.000Z")

    expect(
      findCurrentIngestGaps(getSqlite(), {
        now: new Date("2026-05-28T15:00:00.000Z"),
        lookbackMs: 24 * 60 * 60 * 1000,
        minGapMs: 10 * 60 * 1000,
      })
    ).toEqual([
      {
        startedAtUtc: "2026-05-28T10:00:00.000Z",
        endedAtUtc: "2026-05-28T12:30:00.000Z",
        open: false,
      },
      {
        startedAtUtc: "2026-05-28T12:30:00.000Z",
        endedAtUtc: "2026-05-28T15:00:00.000Z",
        open: true,
      },
    ])
  })

  it("includes the last success before the lookback window", () => {
    insertCurrentIngestSuccess("2026-05-20T10:00:00.000Z")
    insertCurrentIngestSuccess("2026-05-28T14:30:00.000Z")

    expect(
      findCurrentIngestGaps(getSqlite(), {
        now: new Date("2026-05-28T15:00:00.000Z"),
        lookbackMs: 60 * 60 * 1000,
        minGapMs: 10 * 60 * 1000,
      })[0]
    ).toEqual({
      startedAtUtc: "2026-05-20T10:00:00.000Z",
      endedAtUtc: "2026-05-28T14:30:00.000Z",
      open: false,
    })
  })
})

describe("planMetarGapRepairWindows", () => {
  it("waits for closed gaps until the archive should be ready", () => {
    const gaps = [
      {
        startedAtUtc: "2026-05-28T10:00:00.000Z",
        endedAtUtc: "2026-05-28T12:30:00.000Z",
        open: false,
      },
    ]

    expect(
      planMetarGapRepairWindows(gaps, {
        now: new Date("2026-05-28T13:00:00.000Z"),
        overlapMs: 60 * 60 * 1000,
        postGapOverlapMs: 60 * 60 * 1000,
        archiveReadyDelayMs: 60 * 60 * 1000,
      })
    ).toEqual({
      windows: [],
      skippedNotReadyCount: 1,
    })

    expect(
      planMetarGapRepairWindows(gaps, {
        now: new Date("2026-05-28T15:00:00.000Z"),
        overlapMs: 60 * 60 * 1000,
        postGapOverlapMs: 60 * 60 * 1000,
        archiveReadyDelayMs: 60 * 60 * 1000,
      })
    ).toEqual({
      windows: [
        {
          gapStartedAtUtc: "2026-05-28T10:00:00Z",
          gapEndedAtUtc: "2026-05-28T12:30:00Z",
          open: false,
          startDate: "2026-05-28T09:00:00Z",
          endDate: "2026-05-28T14:00:00Z",
        },
      ],
      skippedNotReadyCount: 0,
    })
  })
})

function insertCurrentIngestSuccess(finishedAt: string) {
  getSqlite()
    .prepare(
      `
      INSERT INTO ingest_runs (source, started_at, finished_at, status)
      VALUES (@source, @startedAt, @finishedAt, 'success')
    `
    )
    .run({
      source: AWC_METARS_CACHE_URL,
      startedAt: finishedAt,
      finishedAt,
    })
}
