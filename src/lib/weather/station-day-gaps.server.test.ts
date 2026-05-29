import { describe, expect, it } from "vitest"

import { findStationDayObservationGaps } from "./station-day-gaps.server"

describe("findStationDayObservationGaps", () => {
  it("detects a missing half-hourly tail before day closeout", () => {
    const observations = halfHourlyObservations(
      "2026-05-28T16:00:00.000Z",
      "2026-05-29T14:30:00.000Z"
    )

    expect(
      findStationDayObservationGaps(observations, {
        startUtc: "2026-05-28T16:00:00.000Z",
        endUtc: "2026-05-29T16:00:00.000Z",
      })
    ).toEqual([
      {
        kind: "tail",
        startedAtUtc: "2026-05-29T15:00:00Z",
        endedAtUtc: "2026-05-29T16:00:00Z",
        expectedCadenceMinutes: 30,
      },
    ])
  })

  it("does not flag a complete hourly station day", () => {
    expect(
      findStationDayObservationGaps(
        hourlyObservations(
          "2026-05-29T00:53:00.000Z",
          "2026-05-29T23:53:00.000Z"
        ),
        {
          startUtc: "2026-05-29T00:00:00.000Z",
          endUtc: "2026-05-30T00:00:00.000Z",
        }
      )
    ).toEqual([])
  })

  it("ignores MADIS high-frequency reports when inferring cadence", () => {
    const observations = [
      ...hourlyObservations(
        "2026-05-29T00:53:00.000Z",
        "2026-05-29T04:53:00.000Z"
      ),
      {
        observedAtUtc: "2026-05-29T01:20:00.000Z",
        rawText: "KDEN 290120Z AUTO 10SM CLR 20/10 A3000 RMK MADISHF",
      },
    ]

    expect(
      findStationDayObservationGaps(observations, {
        startUtc: "2026-05-29T00:00:00.000Z",
        endUtc: "2026-05-29T05:00:00.000Z",
        minObservationCount: 4,
      })
    ).toEqual([])
  })
})

function halfHourlyObservations(startUtc: string, endUtc: string) {
  return observationsEvery(startUtc, endUtc, 30)
}

function hourlyObservations(startUtc: string, endUtc: string) {
  return observationsEvery(startUtc, endUtc, 60)
}

function observationsEvery(startUtc: string, endUtc: string, minutes: number) {
  const observations: Array<{ observedAtUtc: string; rawText: string }> = []
  const cursor = new Date(startUtc)
  const end = new Date(endUtc)

  while (cursor <= end) {
    observations.push({
      observedAtUtc: cursor.toISOString(),
      rawText: `METAR KDEN ${metarTime(cursor)}Z 00000KT 10SM CLR 20/10 A3000`,
    })
    cursor.setUTCMinutes(cursor.getUTCMinutes() + minutes)
  }

  return observations
}

function metarTime(date: Date) {
  return `${String(date.getUTCDate()).padStart(2, "0")}${String(
    date.getUTCHours()
  ).padStart(2, "0")}${String(date.getUTCMinutes()).padStart(2, "0")}`
}
