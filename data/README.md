# Weather METARs Data

Runtime data is stored here by default and is ignored by git.

- `weather-metars.sqlite` contains station metadata plus ingest and backfill status.
- Raw METAR observations are stored in SQLite as compressed station/day payloads in `station_day_raw_metars`.
- `raw-metars/<STATION>/<YYYY>/<MM>/<YYYY-MM-DD>.txt` is a legacy import location. Existing files are migrated into SQLite and removed on first raw METAR storage access.
- `source-stations/*.txt` contains provider station lists in `STATION_CODE - Location` format. These files are committed and used to flag stations during startup and station ingest.
- Historical backfill progress is tracked inside SQLite so large IEM SAO archive and CGI downloads can resume after interruption.

Production deployments should mount this directory as persistent storage, or set
`WEATHERMETARS_DB_PATH` to a persistent path. `WEATHERMETARS_RAW_DIR` is only needed when importing legacy raw METAR text files.
