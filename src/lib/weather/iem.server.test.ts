import { describe, expect, it } from "vitest"

import { iemAsosUrl, parseIemAsosCsv } from "./iem.server"

describe("parseIemAsosCsv", () => {
  it("canonicalizes US IEM station IDs from raw METAR text", () => {
    const csv = [
      "station,valid,lon,lat,elevation,tmpf,dwpf,drct,sknt,gust,vsby,alti,mslp,wxcodes,skyc1,skyl1,metar",
      "DEN,2026-05-28 00:53,-104.6575,39.8328,1656.00,58.00,53.00,130.00,8.00,,10.00,30.10,1014.60,,FEW,5000.00,KDEN 280053Z 13008KT 10SM FEW050 14/12 A3010 RMK AO2",
    ].join("\n")

    const [observation] = parseIemAsosCsv(csv)

    expect(observation).toMatchObject({
      stationCode: "KDEN",
      observedAtUtc: "2026-05-28T00:53:00.000Z",
      tempC: 14,
      dewpointC: 12,
      windDirDegrees: 130,
      windSpeedKt: 8,
      metarType: "METAR",
    })
    expect(observation.clouds).toEqual([{ cover: "FEW", baseFtAgl: 5000 }])
  })

  it("tolerates malformed quotes inside IEM METAR text", () => {
    const csv = [
      "station,valid,lon,lat,elevation,tmpf,dwpf,drct,sknt,gust,vsby,alti,mslp,wxcodes,skyc1,skyl1,metar",
      'NSE,2026-05-27 17:56,-87.02,30.72,61.00,84.00,72.00,150.00,13.00,19.00,10.00,30.00,1014.40,,SCT,2700.00,KNSE 271756Z "15013G19KT 10SM SCT027 BKN100 BKN150 BKN250 29/22 A3000 RMK AO2 SLP144',
    ].join("\n")

    const [observation] = parseIemAsosCsv(csv)

    expect(observation).toMatchObject({
      stationCode: "KNSE",
      observedAtUtc: "2026-05-27T17:56:00.000Z",
      tempC: 29,
      dewpointC: 22,
    })
  })

  it("builds global daily requests without station or network parameters", () => {
    const url = iemAsosUrl({
      scope: { type: "global", id: "all" },
      startUtc: "2026-05-28T00:00:00Z",
      endUtc: "2026-05-29T00:00:00Z",
    })

    expect(url.searchParams.has("station")).toBe(false)
    expect(url.searchParams.has("network")).toBe(false)
    expect(url.searchParams.get("sts")).toBe("2026-05-28T00:00:00Z")
    expect(url.searchParams.get("ets")).toBe("2026-05-29T00:00:00Z")
    expect(url.searchParams.getAll("report_type")).toEqual(["1", "3", "4"])
  })
})
