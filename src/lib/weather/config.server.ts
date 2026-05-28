import path from "node:path"

const projectRoot = process.cwd()

export const AWC_METARS_CACHE_URL =
  "https://aviationweather.gov/data/cache/metars.cache.csv.gz"

export const AWC_STATIONS_CACHE_URL =
  "https://aviationweather.gov/data/cache/stations.cache.json.gz"

export const IEM_ASOS_REQUEST_URL =
  "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py"

export const IEM_NETWORKS_URL =
  "https://mesonet.agron.iastate.edu/geojson/networks.py"

export const IEM_SAO_ARCHIVE_BASE_URL =
  "https://mesonet-longterm.agron.iastate.edu/archive/raw/sao"

export const POLL_INTERVAL_MS = 5 * 60 * 1000
export const STATION_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000

export function getDbPath() {
  return (
    process.env.WEATHERMETARS_DB_PATH ??
    path.join(projectRoot, "data", "weather-metars.sqlite")
  )
}

export function getRawMetarsDir() {
  return (
    process.env.WEATHERMETARS_RAW_DIR ??
    path.join(projectRoot, "data", "raw-metars")
  )
}

export function getAwcUserAgent() {
  return (
    process.env.AWC_USER_AGENT ??
    "WeatherMetars/0.1 (+https://github.com/open-source/weather-metars)"
  )
}
