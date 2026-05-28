export type TemperatureUnit = "c" | "f"

export type FlightCategory = "VFR" | "MVFR" | "IFR" | "LIFR" | string

export type CloudLayer = {
  cover: string
  baseFtAgl: number | null
}

export type StationSummary = {
  stationCode: string
  awcId: string | null
  icaoId: string | null
  iataId: string | null
  faaId: string | null
  name: string | null
  state: string | null
  country: string | null
  lat: number | null
  lon: number | null
  elevM: number | null
  timezone: string
  usedByPolymarket: boolean
  usedByInteractiveBrokers: boolean
  usedByRobinhood: boolean
}

export type ObservationRow = {
  id: number
  stationCode: string
  observedAtUtc: string
  observedAtLocal: string
  localTimeLabel: string
  tempC: number | null
  tempF: number | null
  dewpointC: number | null
  dewpointF: number | null
  windDirDegrees: number | null
  windSpeedKt: number | null
  windGustKt: number | null
  visibilityStatuteMi: string | null
  altimeterInHg: number | null
  seaLevelPressureMb: number | null
  wxString: string | null
  flightCategory: FlightCategory | null
  metarType: string | null
  rawText: string
}

export type TemperaturePoint = {
  observedAtUtc: string
  localTimeLabel: string
  tempC: number
  tempF: number | null
}

export type IngestStatus = {
  finishedAt: string | null
  status: string | null
  fetchedCount: number | null
  insertedCount: number | null
  skippedCount: number | null
}

export type PredictionMarketUrls = {
  polymarket: string | null
  interactiveBrokers: string | null
  robinhood: string | null
}

export type DateNavigation = {
  minDate: string
  maxDate: string
}

export type StationDayCoverage = {
  status: "current" | "complete" | "incomplete"
  coverageStartedAtUtc: string | null
  coverageEndedAtUtc: string | null
  completedAt: string | null
}

export type StationDayResponse = {
  station: StationSummary | null
  localDate: string
  highTempC: number | null
  highTempF: number | null
  lowTempC: number | null
  lowTempF: number | null
  chartPoints: TemperaturePoint[]
  observations: ObservationRow[]
  ingestStatus: IngestStatus | null
  predictionMarketUrls: PredictionMarketUrls
  dateNavigation: DateNavigation
  dayCoverage: StationDayCoverage
}

export type MetarObservationInput = {
  stationCode: string
  observedAtUtc: string
  lat: number | null
  lon: number | null
  tempC: number | null
  dewpointC: number | null
  windDirDegrees: number | null
  windSpeedKt: number | null
  windGustKt: number | null
  visibilityStatuteMi: string | null
  altimeterInHg: number | null
  seaLevelPressureMb: number | null
  wxString: string | null
  flightCategory: FlightCategory | null
  metarType: string | null
  clouds: CloudLayer[]
  rawText: string
  elevM: number | null
}
