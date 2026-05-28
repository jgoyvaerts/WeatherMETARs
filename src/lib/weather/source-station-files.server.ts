import fs from "node:fs"
import path from "node:path"

export type SourceStation = {
  stationCode: string
  locationName: string
  slug: string
}

const SOURCE_STATION_DIR = path.resolve(
  process.cwd(),
  "data",
  "source-stations"
)

export function sourceStationsFromFile(fileName: string) {
  const filePath = path.join(SOURCE_STATION_DIR, fileName)
  const content = fs.readFileSync(filePath, "utf8")

  return content
    .split(/\r?\n/)
    .map((line, index) => parseSourceStationLine(line, index + 1, filePath))
    .filter((station): station is SourceStation => station !== null)
}

export function sourceStationSearchText(station: SourceStation | undefined) {
  if (!station) {
    return ""
  }

  return [
    station.stationCode,
    station.locationName,
    station.slug,
    station.slug.replaceAll("-", " "),
  ]
    .join(" ")
    .toLowerCase()
}

function parseSourceStationLine(
  rawLine: string,
  lineNumber: number,
  filePath: string
) {
  const line = rawLine.trim()

  if (!line || line.startsWith("#")) {
    return null
  }

  const match = line.match(/^([A-Z0-9]{4})\s+-\s+(.+)$/)

  if (!match) {
    throw new Error(
      `Invalid source station line in ${filePath}:${lineNumber}. Expected "CODE - Location".`
    )
  }

  const [, stationCode, locationName] = match

  return {
    stationCode,
    locationName: locationName.trim(),
    slug: slugifyLocation(locationName),
  }
}

function slugifyLocation(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}
