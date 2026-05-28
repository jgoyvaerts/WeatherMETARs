import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { getRawMetarsDir } from "./config.server"

export type HistoricalBackfillChunkKey = {
  source: string
  scopeType: string
  scopeId: string
  startedAtUtc: string
  endedAtUtc: string
}

export type HistoricalBackfillChunkMarker = HistoricalBackfillChunkKey & {
  version: 1
  status: "success"
  fetchedCount: number
  insertedCount: number
  skippedCount: number
  errorText: null
  createdAt: string
  finishedAt: string
}

const MARKER_LOOKBACK_DAYS = 35

export function readHistoricalBackfillChunkMarker(
  key: HistoricalBackfillChunkKey
): HistoricalBackfillChunkMarker | null {
  return readMarkerFile(markerPath(key), key)
}

export function writeHistoricalBackfillChunkMarker(
  marker: HistoricalBackfillChunkMarker
) {
  const filePath = markerPath(marker)
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(tempPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8")
  fs.renameSync(tempPath, filePath)
}

export function listHistoricalBackfillChunkMarkers(
  startUtc: string,
  endUtc: string
) {
  const markers = new Map<string, HistoricalBackfillChunkMarker>()

  for (const date of markerCandidateDates(startUtc, endUtc)) {
    const dirPath = markerDateDir(date)

    if (!fs.existsSync(dirPath)) {
      continue
    }

    for (const fileName of fs.readdirSync(dirPath)) {
      if (!fileName.endsWith(".json")) {
        continue
      }

      const marker = readMarkerFile(path.join(dirPath, fileName))
      if (
        marker &&
        marker.endedAtUtc > startUtc &&
        marker.startedAtUtc < endUtc
      ) {
        markers.set(markerId(marker), marker)
      }
    }
  }

  return [...markers.values()].sort((left, right) =>
    left.startedAtUtc.localeCompare(right.startedAtUtc)
  )
}

function readMarkerFile(
  filePath: string,
  expectedKey?: HistoricalBackfillChunkKey
): HistoricalBackfillChunkMarker | null {
  if (!fs.existsSync(filePath)) {
    return null
  }

  try {
    const marker = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown

    if (!isHistoricalBackfillChunkMarker(marker)) {
      return null
    }

    if (expectedKey && markerId(marker) !== markerId(expectedKey)) {
      return null
    }

    return marker
  } catch {
    return null
  }
}

function isHistoricalBackfillChunkMarker(
  value: unknown
): value is HistoricalBackfillChunkMarker {
  if (!value || typeof value !== "object") {
    return false
  }

  const marker = value as Partial<HistoricalBackfillChunkMarker>

  return (
    marker.version === 1 &&
    marker.status === "success" &&
    marker.errorText === null &&
    isNonEmptyString(marker.source) &&
    isNonEmptyString(marker.scopeType) &&
    isNonEmptyString(marker.scopeId) &&
    isIsoTimestamp(marker.startedAtUtc) &&
    isIsoTimestamp(marker.endedAtUtc) &&
    isIsoTimestamp(marker.createdAt) &&
    isIsoTimestamp(marker.finishedAt) &&
    isNonNegativeInteger(marker.fetchedCount) &&
    isNonNegativeInteger(marker.insertedCount) &&
    isNonNegativeInteger(marker.skippedCount)
  )
}

function markerPath(key: HistoricalBackfillChunkKey) {
  const date = datePart(key.startedAtUtc)

  return path.join(markerDateDir(date), `${markerId(key)}.json`)
}

function markerDateDir(date: string) {
  return path.join(
    getRawMetarsDir(),
    ".backfill-chunks",
    date.slice(0, 4),
    date.slice(5, 7),
    date.slice(8, 10)
  )
}

function markerId(key: HistoricalBackfillChunkKey) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        key.source,
        key.scopeType,
        key.scopeId,
        key.startedAtUtc,
        key.endedAtUtc,
      ])
    )
    .digest("hex")
}

function markerCandidateDates(startUtc: string, endUtc: string) {
  const start = parseUtcDay(startUtc)
  const end = parseUtcDay(endUtc)
  const dates: string[] = []

  start.setUTCDate(start.getUTCDate() - MARKER_LOOKBACK_DAYS)
  end.setUTCDate(end.getUTCDate() + 1)

  for (
    const cursor = start;
    cursor <= end;
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    dates.push(cursor.toISOString().slice(0, 10))
  }

  return dates
}

function parseUtcDay(value: string) {
  const date = new Date(value)

  if (!Number.isFinite(date.getTime())) {
    return new Date("1970-01-01T00:00:00.000Z")
  }

  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  )
}

function datePart(value: string) {
  return parseUtcDay(value).toISOString().slice(0, 10)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false
  }

  const date = new Date(value)
  return Number.isFinite(date.getTime()) && value.endsWith("Z")
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}
