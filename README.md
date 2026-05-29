# Weather METARs

Weather METARs is an open-source website for browsing stored METAR weather observations by station.

The project is intended to provide an auditable alternative to Wunderground.com for METAR-based weather data. Prediction markets and event contracts can use weather data as a resolution source, and small differences in reported observations can matter. This repo keeps the ingestion, parsing, storage, and display code public so the data path can be inspected and independently run.

## What It Shows

- Station search with flags for stations used by Polymarket, Interactive Brokers, and Robinhood.
- Highest and lowest stored temperature for a station-local day.
- Temperature charts rendered in local station time.
- Sortable observation tables with raw METAR text.
- Stored current observations from NOAA Aviation Weather Center public cache files.
- Historical backfills from Iowa Environmental Mesonet sources.

## Data Sources

Current observations and station metadata come from public NOAA Aviation Weather Center cache files:

- `https://aviationweather.gov/data/cache/metars.cache.csv.gz`
- `https://aviationweather.gov/data/cache/stations.cache.json.gz`

Historical observations come from Iowa Environmental Mesonet sources:

- `https://mesonet-longterm.agron.iastate.edu/archive/raw/sao/`
- `https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py`
- `https://mesonet.agron.iastate.edu/geojson/networks.py`

The app stores station metadata, ingest/backfill status, and compressed station/day raw METAR payloads in SQLite. Raw observations are parsed on read so displayed values can be audited against the original source text.

## Stack

- TanStack Start, TanStack Router, React, TypeScript
- shadcn/ui and Tailwind CSS
- TanStack Table
- Recharts through the shadcn chart component
- SQLite with explicit startup migrations
- Compressed raw METAR payloads split by station and local day in SQLite
- Bun for package management and command execution

## Local Setup

```bash
bun install
bun run ingest:once
bun run dev
```

Open `http://localhost:3000`.

`bun run ingest:once` syncs station metadata if needed and imports the current global METAR cache once. The station page reads stored observations only; it does not backfill a day on first view.

This repo uses Bun. Do not add pnpm, npm, or yarn lockfiles.

## Runtime Data

Defaults:

- SQLite metadata/status: `data/weather-metars.sqlite`
- Raw METAR observations: compressed station/day rows in SQLite table `station_day_raw_metars`

Environment variables:

- `WEATHERMETARS_DB_PATH`: SQLite database path.
- `WEATHERMETARS_RAW_DIR`: optional legacy raw METAR text-file import directory.
- `AWC_USER_AGENT`: custom user agent for NOAA and IEM requests.

Copy `.env.example` for local overrides.

## Commands

```bash
bun run dev          # TanStack Start dev server
bun run worker:poll  # long-running 5 minute poller
bun run ingest:once  # one station sync/current METAR ingest cycle
bun run backfill:historical -- --all --dry-run
bun run typecheck
bun run test
bun run lint
bun run build
```

## Historical Backfill

The historical backfill is resumable. It records progress in SQLite and writes raw METAR lines into compressed station/day SQLite payloads.

Preview the full global plan:

```bash
bun run backfill:historical -- --all --dry-run
```

Run a limited smoke test:

```bash
bun run backfill:historical -- --all --max-requests=1 --start=2026-04-01 --end=2026-04-02
```

Run the full global historical mirror:

```bash
bun run backfill:historical -- --all --confirm-all
```

Useful scoped alternatives:

```bash
bun run backfill:historical -- --station=KDEN --start=2020-01-01 --end=2021-01-01
bun run backfill:historical -- --network=IA_ASOS --start=2020-01-01 --end=2021-01-01
bun run backfill:historical -- --list-networks
```

Full global history is large. Plan for substantial disk usage and a long-running process.

## Deployment

Operational deployment notes are kept outside the root README in [`deploy/README.md`](deploy/README.md).
