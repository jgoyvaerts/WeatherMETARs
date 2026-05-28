import { describe, expect, it } from "vitest"

import { predictionMarketUrlsForStationDay } from "./prediction-market-urls.server"

describe("predictionMarketUrlsForStationDay", () => {
  it("builds Polymarket event URLs from the platform station slug and local date", () => {
    expect(
      predictionMarketUrlsForStationDay("ZSPD", "2026-05-12").polymarket
    ).toBe(
      "https://polymarket.com/event/highest-temperature-in-shanghai-on-may-12-2026"
    )
  })

  it("builds Robinhood event URLs from the platform station slug and local date", () => {
    expect(
      predictionMarketUrlsForStationDay("KSFO", "2026-05-28").robinhood
    ).toBe(
      "https://robinhood.com/us/en/prediction-markets/climate/events/san-francisco-daily-temperature-high-may-28-2026-may-28-2026/"
    )
  })

  it("uses the general Interactive Brokers prediction markets URL", () => {
    expect(
      predictionMarketUrlsForStationDay("KSFO", "2026-05-28").interactiveBrokers
    ).toBe(
      "https://www.interactivebrokers.com/predictionmarkets/app/#/?category=g137800&sub=g137803"
    )
  })

  it("returns null URLs for stations not tracked by a platform", () => {
    expect(predictionMarketUrlsForStationDay("DNMM", "2026-05-28")).toEqual({
      polymarket: null,
      interactiveBrokers: null,
      robinhood: null,
    })
  })
})
