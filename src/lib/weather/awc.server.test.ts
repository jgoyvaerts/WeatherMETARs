import { describe, expect, it } from "vitest"

import { parseMetarCsv } from "./awc.server"

describe("parseMetarCsv", () => {
  it("parses AWC cache rows with repeated cloud columns", () => {
    const csv = [
      "raw_text,station_id,observation_time,latitude,longitude,temp_c,dewpoint_c,wind_dir_degrees,wind_speed_kt,wind_gust_kt,visibility_statute_mi,altim_in_hg,sea_level_pressure_mb,wx_string,sky_cover,cloud_base_ft_agl,sky_cover,cloud_base_ft_agl,flight_category,metar_type,elevation_m",
      '"METAR KDEN 281653Z 04004KT 10SM SCT040 BKN130 18/11 A3012",KDEN,2026-05-28T16:53:00.000Z,39.8466,-104.6562,18.3,10.6,40,4,,10+,30.12,1014.4,,SCT,4000,BKN,13000,VFR,METAR,1656',
    ].join("\n")

    const [observation] = parseMetarCsv(csv)

    expect(observation).toMatchObject({
      stationCode: "KDEN",
      observedAtUtc: "2026-05-28T16:53:00.000Z",
      tempC: 18,
      dewpointC: 11,
      windSpeedKt: 4,
      flightCategory: "VFR",
      metarType: "METAR",
    })
    expect(observation.clouds).toEqual([
      { cover: "SCT", baseFtAgl: 4000 },
      { cover: "BKN", baseFtAgl: 13000 },
    ])
  })
})
