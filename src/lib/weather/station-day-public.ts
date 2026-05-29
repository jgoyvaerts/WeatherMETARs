import type {
  IngestStatus,
  ObservationRow,
  PredictionMarketUrls,
  StationDayCoverage,
  StationDayResponse,
  StationSummary,
  TemperaturePoint,
} from "./types"

export type PublicStationSummary = Pick<
  StationSummary,
  "stationCode" | "name" | "state" | "country" | "timezone"
>

export type PublicTemperaturePoint = Pick<
  TemperaturePoint,
  "localTimeLabel" | "tempC" | "tempF"
>

export type PublicObservationRow = Pick<
  ObservationRow,
  | "observedAtUtc"
  | "localTimeLabel"
  | "tempC"
  | "tempF"
  | "dewpointC"
  | "dewpointF"
  | "rawText"
>

export type PublicIngestStatus = Pick<IngestStatus, "finishedAt">

export type PublicStationDayCoverage = Pick<StationDayCoverage, "status">

export type PublicStationDayResponse = {
  station: PublicStationSummary | null
  localDate: string
  highTempC: number | null
  highTempF: number | null
  lowTempC: number | null
  lowTempF: number | null
  chartPoints: PublicTemperaturePoint[]
  observations: PublicObservationRow[]
  ingestStatus: PublicIngestStatus | null
  predictionMarketUrls: PredictionMarketUrls
  dateNavigation: StationDayResponse["dateNavigation"]
  dayCoverage: PublicStationDayCoverage
}

export function toPublicStationDayResponse(
  data: StationDayResponse
): PublicStationDayResponse {
  return {
    station: data.station ? toPublicStationSummary(data.station) : null,
    localDate: data.localDate,
    highTempC: data.highTempC,
    highTempF: data.highTempF,
    lowTempC: data.lowTempC,
    lowTempF: data.lowTempF,
    chartPoints: data.chartPoints.map(toPublicTemperaturePoint),
    observations: data.observations.map(toPublicObservationRow),
    ingestStatus: data.ingestStatus
      ? { finishedAt: data.ingestStatus.finishedAt }
      : null,
    predictionMarketUrls: data.predictionMarketUrls,
    dateNavigation: data.dateNavigation,
    dayCoverage: { status: data.dayCoverage.status },
  }
}

function toPublicStationSummary(station: StationSummary): PublicStationSummary {
  return {
    stationCode: station.stationCode,
    name: station.name,
    state: station.state,
    country: station.country,
    timezone: station.timezone,
  }
}

function toPublicTemperaturePoint(
  point: TemperaturePoint
): PublicTemperaturePoint {
  return {
    localTimeLabel: point.localTimeLabel,
    tempC: point.tempC,
    tempF: point.tempF,
  }
}

function toPublicObservationRow(
  observation: ObservationRow
): PublicObservationRow {
  return {
    observedAtUtc: observation.observedAtUtc,
    localTimeLabel: observation.localTimeLabel,
    tempC: observation.tempC,
    tempF: observation.tempF,
    dewpointC: observation.dewpointC,
    dewpointF: observation.dewpointF,
    rawText: observation.rawText,
  }
}
