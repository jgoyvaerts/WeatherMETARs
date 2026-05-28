import {
  sourceStationSearchText,
  sourceStationsFromFile,
} from "./source-station-files.server"

export const INTERACTIVE_BROKERS_STATIONS = sourceStationsFromFile(
  "interactive-brokers.txt"
)

const interactiveBrokersStationByCode = new Map(
  INTERACTIVE_BROKERS_STATIONS.map((station) => [station.stationCode, station])
)

export function isInteractiveBrokersStationCode(
  stationCode: string | null | undefined
) {
  return interactiveBrokersStationByCode.has(
    stationCode?.trim().toUpperCase() ?? ""
  )
}

export function interactiveBrokersStationSearchText(stationCode: string) {
  return sourceStationSearchText(
    interactiveBrokersStationByCode.get(stationCode.trim().toUpperCase())
  )
}

export function interactiveBrokersStationForCode(stationCode: string) {
  return (
    interactiveBrokersStationByCode.get(stationCode.trim().toUpperCase()) ??
    null
  )
}
