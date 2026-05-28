# Weather METARs Data

Runtime data is stored here by default and is ignored by git.

- `weather-metars.sqlite` contains station metadata plus ingest and backfill status.
- `raw-metars/<STATION>/<YYYY>/<MM>/<YYYY-MM-DD>.txt` contains raw METAR observation lines split by station-local day.
- `source-stations/*.txt` contains provider station lists in `STATION_CODE - Location` format. These files are committed and used to flag stations during startup and station ingest.
- Historical backfill progress is tracked inside SQLite so large IEM SAO archive and CGI downloads can resume after interruption.

Production deployments should mount this directory as persistent storage, or set
`WEATHERMETARS_DB_PATH` and `WEATHERMETARS_RAW_DIR` to persistent paths.
