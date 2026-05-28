import {
  sourceStationSearchText,
  sourceStationsFromFile,
} from "./source-station-files.server"

export const POLYMARKET_STATIONS = sourceStationsFromFile("polymarket.txt")

const polymarketStationByCode = new Map(
  POLYMARKET_STATIONS.map((station) => [station.stationCode, station])
)

export function isPolymarketStationCode(
  stationCode: string | null | undefined
) {
  return polymarketStationByCode.has(stationCode?.trim().toUpperCase() ?? "")
}

export function polymarketStationSearchText(stationCode: string) {
  return sourceStationSearchText(
    polymarketStationByCode.get(stationCode.trim().toUpperCase())
  )
}

export function polymarketStationForCode(stationCode: string) {
  return polymarketStationByCode.get(stationCode.trim().toUpperCase()) ?? null
}
