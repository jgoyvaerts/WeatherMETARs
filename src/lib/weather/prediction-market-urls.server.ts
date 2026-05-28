import { interactiveBrokersStationForCode } from "./interactive-brokers-stations"
import { polymarketStationForCode } from "./polymarket-stations"
import { robinhoodStationForCode } from "./robinhood-stations"
import type { PredictionMarketUrls } from "./types"

const INTERACTIVE_BROKERS_PREDICTION_MARKETS_URL =
  "https://www.interactivebrokers.com/predictionmarkets/app/#/?category=g137800&sub=g137803"

const MONTH_SLUGS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
]

export function predictionMarketUrlsForStationDay(
  stationCode: string,
  localDate: string
): PredictionMarketUrls {
  const dateSlug = localDateSlug(localDate)
  const polymarketStation = polymarketStationForCode(stationCode)
  const interactiveBrokersStation =
    interactiveBrokersStationForCode(stationCode)
  const robinhoodStation = robinhoodStationForCode(stationCode)

  return {
    polymarket: polymarketStation
      ? `https://polymarket.com/event/highest-temperature-in-${polymarketStation.slug}-on-${dateSlug}`
      : null,
    interactiveBrokers: interactiveBrokersStation
      ? INTERACTIVE_BROKERS_PREDICTION_MARKETS_URL
      : null,
    robinhood: robinhoodStation
      ? `https://robinhood.com/us/en/prediction-markets/climate/events/${robinhoodStation.slug}-daily-temperature-high-${dateSlug}-${dateSlug}/`
      : null,
  }
}

function localDateSlug(localDate: string) {
  const match = localDate.match(/^(\d{4})-(\d{2})-(\d{2})$/)

  if (!match) {
    return localDate.toLowerCase()
  }

  const [, year, month, day] = match
  const monthName = MONTH_SLUGS[Number(month) - 1]

  if (!monthName) {
    return localDate.toLowerCase()
  }

  return `${monthName}-${Number(day)}-${year}`
}
