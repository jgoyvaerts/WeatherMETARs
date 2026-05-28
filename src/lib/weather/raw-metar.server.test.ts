import { describe, expect, it } from "vitest"

import {
  parseRawMetarObservation,
  preciseTemperaturePairFromRawMetar,
  temperaturePairFromRawMetar,
} from "./raw-metar.server"

describe("raw METAR temperature parsing", () => {
  it("keeps temperature when METAR omits dewpoint", () => {
    const rawText =
      "METAR KLPC 290451Z AUTO 10003KT 10SM BKN036 BKN046 OVC055 13/ A2998 RMK AO2 RAE19 SLP150 P0000 T0133"

    expect(temperaturePairFromRawMetar(rawText)).toEqual({
      temperatureC: 13,
      dewpointC: null,
    })
    expect(preciseTemperaturePairFromRawMetar(rawText)).toEqual({
      temperatureC: 13.3,
      dewpointC: null,
    })
    expect(
      parseRawMetarObservation({
        rawText,
        observedAtUtc: "2026-05-29T04:51:00.000Z",
      })
    ).toMatchObject({
      stationCode: "KLPC",
      tempC: 13,
      dewpointC: null,
      rawText,
    })
  })
})
