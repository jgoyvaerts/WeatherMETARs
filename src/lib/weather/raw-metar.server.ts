import type { CloudLayer, MetarObservationInput } from "./types"

const METAR_STATION_CODE_PATTERN = /^[A-Z0-9]{3,4}$/

export function parseRawMetarObservation({
  rawText,
  observedAtUtc,
  reportType = "METAR",
}: {
  rawText: string
  observedAtUtc: string
  reportType?: string
}): MetarObservationInput | null {
  const normalizedRawText = normalizeRawMetarText(rawText, reportType)
  const stationCode = stationCodeFromRawMetar(normalizedRawText)
  if (!stationCode) {
    return null
  }

  return {
    stationCode,
    observedAtUtc,
    lat: null,
    lon: null,
    tempC: temperatureCFromRawMetar(normalizedRawText),
    dewpointC: dewpointCFromRawMetar(normalizedRawText),
    windDirDegrees: windDirectionFromRawMetar(normalizedRawText),
    windSpeedKt: windSpeedKtFromRawMetar(normalizedRawText),
    windGustKt: windGustKtFromRawMetar(normalizedRawText),
    visibilityStatuteMi: visibilityFromRawMetar(normalizedRawText),
    altimeterInHg: altimeterInHgFromRawMetar(normalizedRawText),
    seaLevelPressureMb: seaLevelPressureMbFromRawMetar(normalizedRawText),
    wxString: null,
    flightCategory: null,
    metarType: metarTypeFromRawMetar(normalizedRawText, reportType),
    clouds: cloudLayersFromRawMetar(normalizedRawText),
    rawText: normalizedRawText,
    elevM: null,
  }
}

export function normalizeRawMetarText(rawText: string, reportType = "METAR") {
  const normalized = rawText.replace(/\s+/g, " ").trim()
  const firstToken = normalized.split(/\s+/, 1)[0]?.toUpperCase()

  if (!normalized || firstToken === "METAR" || firstToken === "SPECI") {
    return normalized
  }

  return `${canonicalReportType(reportType)} ${normalized}`
}

export function stationCodeFromRawMetar(rawText: string) {
  const tokens = rawText.trim().split(/\s+/)

  for (const token of tokens.slice(0, 4)) {
    const normalized = token.toUpperCase()
    if (["METAR", "SPECI", "COR", "AMD"].includes(normalized)) {
      continue
    }

    const stationCode = normalizeMetarStationCode(normalized)
    if (stationCode && stationCode.length === 4) {
      return stationCode
    }
  }

  return null
}

export function normalizeMetarStationCode(stationCode: string) {
  const normalized = stationCode.trim().toUpperCase()
  return METAR_STATION_CODE_PATTERN.test(normalized) ? normalized : null
}

export function hasRawMetarToken(rawText: string, token: string) {
  const normalizedToken = token.toUpperCase()
  return rawText
    .trim()
    .split(/\s+/)
    .some((part) => part.toUpperCase() === normalizedToken)
}

function canonicalReportType(reportType: string) {
  return reportType.trim().toUpperCase() === "SPECI" ? "SPECI" : "METAR"
}

export function metarTypeFromRawMetar(rawText: string, fallback = "METAR") {
  const firstToken = rawText.trim().split(/\s+/, 1)[0]?.toUpperCase()
  if (firstToken === "SPECI") {
    return "SPECI"
  }

  if (firstToken === "METAR") {
    return "METAR"
  }

  if (fallback.toUpperCase() === "SPECI") {
    return "SPECI"
  }

  return "METAR"
}

export function temperatureCFromRawMetar(rawText: string) {
  return temperaturePairFromRawMetar(rawText)?.temperatureC ?? null
}

export function dewpointCFromRawMetar(rawText: string) {
  return temperaturePairFromRawMetar(rawText)?.dewpointC ?? null
}

export function temperaturePairFromRawMetar(rawText: string) {
  const match = rawText.match(
    /(?:^|\s)(M?\d{2}|\/\/)\/((?:M?\d{2}|\/\/)?)(?=\s|$)/
  )
  if (!match) {
    return null
  }

  return {
    temperatureC: signedTemperature(match[1]),
    dewpointC: signedTemperature(match[2]),
  }
}

export function preciseTemperaturePairFromRawMetar(rawText: string) {
  const match = rawText.match(
    /(?:^|\s)T([01])(\d{3})(?:([01])(\d{3}))?(?=\s|$)/
  )
  if (!match) {
    return null
  }

  return {
    temperatureC: signedTenthsTemperature(match[1], match[2]),
    dewpointC: signedTenthsTemperature(match[3], match[4]),
  }
}

function signedTemperature(value: string | undefined) {
  if (!value || value === "//") {
    return null
  }

  const sign = value.startsWith("M") ? -1 : 1
  const digits = value.replace(/^M/, "")
  const parsed = Number(digits)

  return Number.isFinite(parsed) ? sign * parsed : null
}

function signedTenthsTemperature(
  signCode: string | undefined,
  digits: string | undefined
) {
  if (!signCode || !digits) {
    return null
  }

  const parsed = Number(digits)
  if (!Number.isFinite(parsed)) {
    return null
  }

  return (signCode === "1" ? -1 : 1) * (parsed / 10)
}

function windDirectionFromRawMetar(rawText: string) {
  const match = windMatch(rawText)
  if (!match || match[1] === "VRB") {
    return null
  }

  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : null
}

function windSpeedKtFromRawMetar(rawText: string) {
  const match = windMatch(rawText)
  return integerValue(match?.[2])
}

function windGustKtFromRawMetar(rawText: string) {
  const match = windMatch(rawText)
  return integerValue(match?.[3])
}

function windMatch(rawText: string) {
  return rawText.match(/(?:^|\s)(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT(?=\s|$)/)
}

function visibilityFromRawMetar(rawText: string) {
  const match = rawText.match(
    /(?:^|\s)((?:(?:P|M)?\d+\s)?(?:\d+\/\d+|\d+(?:\.\d+)?)(?:SM))(?=\s|$)/
  )

  return match?.[1]?.trim() ?? null
}

function altimeterInHgFromRawMetar(rawText: string) {
  const match = rawText.match(/(?:^|\s)A(\d{4})(?=\s|$)/)
  const parsed = integerValue(match?.[1])

  return parsed === null ? null : parsed / 100
}

function seaLevelPressureMbFromRawMetar(rawText: string) {
  const qnhMatch = rawText.match(/(?:^|\s)Q(\d{4})(?=\s|$)/)
  const qnh = integerValue(qnhMatch?.[1])
  if (qnh !== null) {
    return qnh
  }

  const slpMatch = rawText.match(/(?:^|\s)SLP(\d{3})(?=\s|$)/)
  const slp = integerValue(slpMatch?.[1])
  if (slp === null) {
    return null
  }

  const tenths = slp / 10
  return tenths < 50 ? 1000 + tenths : 900 + tenths
}

function cloudLayersFromRawMetar(rawText: string): CloudLayer[] {
  const layers: CloudLayer[] = []
  const cloudRegex = /(?:^|\s)(FEW|SCT|BKN|OVC|VV)(\d{3}|\/\/\/)?/g
  let match: RegExpExecArray | null

  while ((match = cloudRegex.exec(rawText)) !== null) {
    const baseCode = match[2]
    layers.push({
      cover: match[1],
      baseFtAgl: baseCode && baseCode !== "///" ? Number(baseCode) * 100 : null,
    })
  }

  return layers
}

function integerValue(value: string | undefined) {
  if (!value) {
    return null
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null
}
