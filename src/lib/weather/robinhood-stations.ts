import {
  sourceStationSearchText,
  sourceStationsFromFile,
} from "./source-station-files.server"

export const ROBINHOOD_STATIONS = sourceStationsFromFile("robinhood.txt")

const robinhoodStationByCode = new Map(
  ROBINHOOD_STATIONS.map((station) => [station.stationCode, station])
)

export function isRobinhoodStationCode(stationCode: string | null | undefined) {
  return robinhoodStationByCode.has(stationCode?.trim().toUpperCase() ?? "")
}

export function robinhoodStationSearchText(stationCode: string) {
  return sourceStationSearchText(
    robinhoodStationByCode.get(stationCode.trim().toUpperCase())
  )
}

export function robinhoodStationForCode(stationCode: string) {
  return robinhoodStationByCode.get(stationCode.trim().toUpperCase()) ?? null
}
