import { parse } from "csv-parse/sync"

import {
  IEM_ASOS_REQUEST_URL,
  IEM_NETWORKS_URL,
  getAwcUserAgent,
} from "./config.server"
import {
  normalizeMetarStationCode,
  normalizeRawMetarText,
  stationCodeFromRawMetar,
  temperaturePairFromRawMetar,
} from "./raw-metar.server"
import type { CloudLayer, MetarObservationInput } from "./types"

type IemCsvRecord = Record<string, string | undefined>

type IemNetworkFeatureCollection = {
  features: Array<{
    id?: string
    properties?: {
      name?: string
    }
  }>
}

export type IemBackfillScope =
  | { type: "global"; id: "all" }
  | { type: "network"; id: string }
  | { type: "station"; id: string }

export type IemNetwork = {
  id: string
  name: string
}

export type IemFetchOptions = {
  scope: IemBackfillScope
  startUtc: string
  endUtc: string
  reportTypes?: string[]
}

export class IemRequestError extends Error {
  status: number
  retryAfterMs: number | null

  constructor({
    message,
    status,
    retryAfterMs,
  }: {
    message: string
    status: number
    retryAfterMs: number | null
  }) {
    super(message)
    this.name = "IemRequestError"
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

const IEM_DATA_COLUMNS = [
  "tmpf",
  "dwpf",
  "drct",
  "sknt",
  "gust",
  "vsby",
  "alti",
  "mslp",
  "wxcodes",
  "skyc1",
  "skyc2",
  "skyc3",
  "skyc4",
  "skyl1",
  "skyl2",
  "skyl3",
  "skyl4",
  "metar",
] as const

const DEFAULT_REPORT_TYPES = ["1", "3", "4"] as const

export async function fetchIemAsosNetworks(): Promise<IemNetwork[]> {
  const response = await fetch(IEM_NETWORKS_URL, {
    headers: { "User-Agent": getAwcUserAgent() },
  })

  if (!response.ok) {
    throw new Error(
      `IEM network request failed ${response.status} ${response.statusText}`
    )
  }

  const body = (await response.json()) as IemNetworkFeatureCollection

  return body.features
    .flatMap((feature) => {
      const id = feature.id?.trim()
      if (!id || !id.endsWith("_ASOS")) {
        return []
      }

      return {
        id,
        name: feature.properties?.name ?? id,
      }
    })
    .sort((left, right) => left.id.localeCompare(right.id))
}

export async function fetchIemHistoricalMetars({
  scope,
  startUtc,
  endUtc,
  reportTypes = [...DEFAULT_REPORT_TYPES],
}: IemFetchOptions) {
  const url = iemAsosUrl({ scope, startUtc, endUtc, reportTypes })
  const response = await fetch(url, {
    headers: { "User-Agent": getAwcUserAgent() },
  })

  if (!response.ok) {
    const text = await response.text()
    throw new IemRequestError({
      message: `IEM ASOS request failed ${response.status} ${response.statusText}: ${text.slice(0, 500)}`,
      status: response.status,
      retryAfterMs: retryAfterHeaderMs(response.headers.get("retry-after")),
    })
  }

  return parseIemAsosCsv(await response.text())
}

export function iemAsosUrl({
  scope,
  startUtc,
  endUtc,
  reportTypes = [...DEFAULT_REPORT_TYPES],
}: IemFetchOptions) {
  const url = new URL(IEM_ASOS_REQUEST_URL)

  for (const column of IEM_DATA_COLUMNS) {
    url.searchParams.append("data", column)
  }

  if (scope.type === "network") {
    url.searchParams.set("network", scope.id)
  } else if (scope.type === "station") {
    url.searchParams.set("station", scope.id)
  }

  url.searchParams.set("sts", startUtc)
  url.searchParams.set("ets", endUtc)
  url.searchParams.set("tz", "UTC")
  url.searchParams.set("format", "onlycomma")
  url.searchParams.set("latlon", "yes")
  url.searchParams.set("elev", "yes")
  url.searchParams.set("missing", "empty")
  url.searchParams.set("trace", "empty")
  url.searchParams.set("direct", "no")

  for (const reportType of reportTypes) {
    url.searchParams.append("report_type", reportType)
  }

  return url
}

export function parseIemAsosCsv(csv: string): MetarObservationInput[] {
  const records: IemCsvRecord[] = parse(csv, {
    columns: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    trim: true,
  })

  return records.flatMap((record) => {
    const rawTextValue = cleanString(record.metar)
    const observedAtUtc = normalizeIemValid(record.valid)

    if (!rawTextValue || !observedAtUtc) {
      return []
    }

    const rawText = normalizeRawMetarText(rawTextValue)
    const stationCode = canonicalStationCode(record.station, rawText)
    if (!stationCode) {
      return []
    }

    const rawTemperaturePair = temperaturePairFromRawMetar(rawText)

    return {
      stationCode,
      observedAtUtc,
      lat: numberValue(record.lat),
      lon: numberValue(record.lon),
      tempC: rawTemperaturePair
        ? rawTemperaturePair.temperatureC
        : fahrenheitToC(numberValue(record.tmpf)),
      dewpointC: rawTemperaturePair
        ? rawTemperaturePair.dewpointC
        : fahrenheitToC(numberValue(record.dwpf)),
      windDirDegrees: integerValue(record.drct),
      windSpeedKt: integerValue(record.sknt),
      windGustKt: integerValue(record.gust),
      visibilityStatuteMi: cleanString(record.vsby),
      altimeterInHg: numberValue(record.alti),
      seaLevelPressureMb: numberValue(record.mslp),
      wxString: cleanString(record.wxcodes),
      flightCategory: null,
      metarType: metarType(rawText),
      clouds: cloudLayers(record),
      rawText,
      elevM: numberValue(record.elevation),
    }
  })
}

function cloudLayers(record: IemCsvRecord): CloudLayer[] {
  return [1, 2, 3, 4].flatMap((index) => {
    const cover = cleanString(record[`skyc${index}`])
    if (!cover) {
      return []
    }

    return {
      cover,
      baseFtAgl: integerValue(record[`skyl${index}`]),
    }
  })
}

function canonicalStationCode(station: string | undefined, rawText: string) {
  const rawStation = stationCodeFromRawMetar(rawText)
  if (rawStation) {
    return rawStation
  }

  return normalizeMetarStationCode(station ?? "")
}

function metarType(rawText: string) {
  const firstToken = rawText.trim().split(/\s+/, 1)[0]?.toUpperCase()
  return firstToken === "SPECI" ? "SPECI" : "METAR"
}

function normalizeIemValid(value: string | undefined) {
  const clean = cleanString(value)
  if (!clean) {
    return null
  }

  const isoText = clean.includes("T")
    ? clean
    : `${clean.replace(" ", "T")}${clean.length === 16 ? ":00" : ""}Z`
  const date = new Date(isoText)

  if (Number.isNaN(date.getTime())) {
    return null
  }

  return date.toISOString()
}

function fahrenheitToC(value: number | null) {
  return value === null ? null : ((value - 32) * 5) / 9
}

function numberValue(value: string | undefined) {
  const clean = cleanString(value)
  if (!clean || clean === "M" || clean === "T") {
    return null
  }

  const parsed = Number(clean)
  return Number.isFinite(parsed) ? parsed : null
}

function integerValue(value: string | undefined) {
  const parsed = numberValue(value)
  return parsed === null ? null : Math.trunc(parsed)
}

function cleanString(value: string | undefined) {
  const clean = value?.trim()
  return clean ? clean : null
}

function retryAfterHeaderMs(value: string | null) {
  if (!value) {
    return null
  }

  const seconds = Number(value)
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000)
  }

  const date = new Date(value)
  if (!Number.isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now())
  }

  return null
}
