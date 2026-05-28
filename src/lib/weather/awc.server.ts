import { gunzipSync } from "node:zlib"
import { parse } from "csv-parse/sync"

import {
  AWC_METARS_CACHE_URL,
  AWC_STATIONS_CACHE_URL,
  getAwcUserAgent,
} from "./config.server"
import {
  normalizeMetarStationCode,
  normalizeRawMetarText,
  temperaturePairFromRawMetar,
} from "./raw-metar.server"
import type { CloudLayer, MetarObservationInput } from "./types"

type CsvRecord = Record<string, string | string[] | undefined>

export type AwcStation = {
  id: string | null
  icaoId: string | null
  iataId: string | null
  faaId: string | null
  site: string | null
  lat: number | null
  lon: number | null
  elev: number | null
  state: string | null
  country: string | null
}

export async function fetchGzippedText(url: string) {
  const response = await fetch(url, {
    headers: { "User-Agent": getAwcUserAgent() },
  })

  if (!response.ok) {
    throw new Error(
      `AWC request failed ${response.status} ${response.statusText}`
    )
  }

  return gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8")
}

export async function fetchCurrentMetars() {
  const csv = await fetchGzippedText(AWC_METARS_CACHE_URL)
  return parseMetarCsv(csv)
}

export async function fetchStations() {
  const json = await fetchGzippedText(AWC_STATIONS_CACHE_URL)
  return JSON.parse(json) as AwcStation[]
}

export function parseMetarCsv(csv: string): MetarObservationInput[] {
  const records: CsvRecord[] = parse(csv, {
    columns: true,
    group_columns_by_name: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  })

  return records.flatMap((record) => {
    const stationCode = cleanCode(textValue(record.station_id))
    const rawTextValue = textValue(record.raw_text)?.trim()
    const observedAtUtc = normalizeUtc(textValue(record.observation_time))

    if (!stationCode || !rawTextValue || !observedAtUtc) {
      return []
    }

    const rawText = normalizeRawMetarText(
      rawTextValue,
      textValue(record.metar_type) ?? "METAR"
    )
    const rawTemperaturePair = temperaturePairFromRawMetar(rawText)

    return [
      {
        stationCode,
        observedAtUtc,
        lat: numberValue(record.latitude),
        lon: numberValue(record.longitude),
        tempC: rawTemperaturePair
          ? rawTemperaturePair.temperatureC
          : numberValue(record.temp_c),
        dewpointC: rawTemperaturePair
          ? rawTemperaturePair.dewpointC
          : numberValue(record.dewpoint_c),
        windDirDegrees: integerValue(record.wind_dir_degrees),
        windSpeedKt: integerValue(record.wind_speed_kt),
        windGustKt: integerValue(record.wind_gust_kt),
        visibilityStatuteMi: textValue(record.visibility_statute_mi),
        altimeterInHg: numberValue(record.altim_in_hg),
        seaLevelPressureMb: numberValue(record.sea_level_pressure_mb),
        wxString: textValue(record.wx_string),
        flightCategory: textValue(record.flight_category),
        metarType: textValue(record.metar_type),
        clouds: cloudLayers(record.sky_cover, record.cloud_base_ft_agl),
        rawText,
        elevM: numberValue(record.elevation_m),
      },
    ]
  })
}

function cloudLayers(
  coversValue: string | string[] | undefined,
  basesValue: string | string[] | undefined
): CloudLayer[] {
  const covers = arrayValue(coversValue)
  const bases = arrayValue(basesValue)

  return covers.flatMap((cover, index) => {
    if (!cover) {
      return []
    }

    return {
      cover,
      baseFtAgl: integerValue(bases[index]),
    }
  })
}

function textValue(value: string | string[] | undefined) {
  const text = Array.isArray(value) ? value[0] : value
  if (text === undefined || text === "") {
    return null
  }

  return text
}

function arrayValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value
  }

  return value ? [value] : []
}

function numberValue(value: string | string[] | undefined) {
  const text = textValue(value)
  if (text === null) {
    return null
  }

  const normalized = text.endsWith("+") ? text.slice(0, -1) : text
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function integerValue(value: string | string[] | undefined) {
  const parsed = numberValue(value)
  return parsed === null ? null : Math.trunc(parsed)
}

function cleanCode(value: string | null) {
  return normalizeMetarStationCode(value ?? "")
}

function normalizeUtc(value: string | null) {
  if (!value) {
    return null
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  return date.toISOString()
}
