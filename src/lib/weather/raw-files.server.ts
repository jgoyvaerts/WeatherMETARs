import fs from "node:fs"
import path from "node:path"

import { getRawMetarsDir } from "./config.server"
import { normalizeMetarStationCode } from "./raw-metar.server"

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export type RawMetarAppend = {
  stationCode: string
  localDate: string
  observedAtUtc: string
  rawText: string
}

export type RawMetarEntry = {
  observedAtUtc: string
  rawText: string
}

export function rawMetarPath(stationCode: string, localDate: string) {
  const normalizedStationCode = normalizeMetarStationCode(stationCode)
  const normalizedLocalDate = normalizeRawMetarLocalDate(localDate)

  if (!normalizedStationCode) {
    throw new Error(`Invalid METAR station code: ${stationCode}`)
  }

  if (!normalizedLocalDate) {
    throw new Error(`Invalid METAR local date: ${localDate}`)
  }

  const [year, month] = normalizedLocalDate.split("-")
  return path.join(
    getRawMetarsDir(),
    normalizedStationCode,
    year,
    month,
    `${normalizedLocalDate}.txt`
  )
}

export function normalizeRawMetarLocalDate(localDate: string) {
  const normalized = localDate.trim()
  if (!LOCAL_DATE_PATTERN.test(normalized)) {
    return null
  }

  const date = new Date(`${normalized}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === normalized
    ? normalized
    : null
}

export function readRawMetarEntries(
  stationCode: string,
  localDate: string
): RawMetarEntry[] {
  const filePath = rawMetarPath(stationCode, localDate)

  if (!fs.existsSync(filePath)) {
    return []
  }

  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .flatMap((line) => parseRawMetarLine(line, localDate))
}

export function writeRawMetarEntries(
  stationCode: string,
  localDate: string,
  entries: RawMetarEntry[]
) {
  const filePath = rawMetarPath(stationCode, localDate)
  const sortedEntries = [...entries].sort((left, right) =>
    left.observedAtUtc.localeCompare(right.observedAtUtc)
  )

  fs.mkdirSync(path.dirname(filePath), { recursive: true })

  if (sortedEntries.length === 0) {
    fs.rmSync(filePath, { force: true })
    return
  }

  fs.writeFileSync(
    filePath,
    `${sortedEntries
      .map((entry) => `${entry.observedAtUtc}\t${entry.rawText.trim()}`)
      .join("\n")}\n`,
    "utf8"
  )
}

export function appendRawMetars(appends: RawMetarAppend[]) {
  const entriesByPath = new Map<
    string,
    { stationCode: string; localDate: string; entries: RawMetarEntry[] }
  >()

  for (const append of appends) {
    const filePath = rawMetarPath(append.stationCode, append.localDate)
    const group = entriesByPath.get(filePath) ?? {
      stationCode: append.stationCode,
      localDate: append.localDate,
      entries: [],
    }
    group.entries.push({
      observedAtUtc: append.observedAtUtc,
      rawText: append.rawText,
    })
    entriesByPath.set(filePath, group)
  }

  for (const { stationCode, localDate, entries } of entriesByPath.values()) {
    writeRawMetarEntries(stationCode, localDate, [
      ...readRawMetarEntries(stationCode, localDate),
      ...entries,
    ])
  }
}

function parseRawMetarLine(line: string, localDate: string) {
  const trimmed = line.trim()
  if (!trimmed) {
    return []
  }

  const separatorIndex = trimmed.indexOf("\t")
  if (separatorIndex > 0) {
    const observedAtUtc = trimmed.slice(0, separatorIndex)
    const rawText = trimmed.slice(separatorIndex + 1).trim()

    if (isIsoUtcTimestamp(observedAtUtc) && rawText) {
      return [{ observedAtUtc, rawText }]
    }
  }

  const observedAtUtc = inferObservedAtUtc(trimmed, localDate)
  return observedAtUtc ? [{ observedAtUtc, rawText: trimmed }] : []
}

function isIsoUtcTimestamp(value: string) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

function inferObservedAtUtc(rawText: string, localDate: string) {
  const match = rawText.match(/(?:^|\s)(\d{2})(\d{2})(\d{2})Z(?=\s|$)/)
  if (!match) {
    return null
  }

  const [, dayText, hourText, minuteText] = match
  const reportDay = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const base = new Date(`${localDate}T00:00:00.000Z`)

  if (
    !Number.isFinite(base.getTime()) ||
    !Number.isFinite(reportDay) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    return null
  }

  for (const offsetDays of [-1, 0, 1]) {
    const candidate = new Date(base)
    candidate.setUTCDate(candidate.getUTCDate() + offsetDays)

    if (candidate.getUTCDate() !== reportDay) {
      continue
    }

    candidate.setUTCHours(hour, minute, 0, 0)
    return candidate.toISOString()
  }

  return null
}
