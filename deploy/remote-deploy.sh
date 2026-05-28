#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/weathermetars/app}"
APP_DATA_DIR="${APP_DATA_DIR:-/mnt/weathermetars}"
APP_ENV_FILE="${APP_ENV_FILE:-/etc/weathermetars/weathermetars.env}"
SERVICE_PREFIX="${SERVICE_PREFIX:-weathermetars}"

export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is not installed or is not on PATH. Install Bun for the deploy user before deploying." >&2
  exit 1
fi

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo -n "$@"
  fi
}

cd "$APP_DIR"

if [ -f "$APP_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$APP_ENV_FILE"
  set +a
fi

runtime_node_env="${NODE_ENV:-production}"
export NODE_ENV="$runtime_node_env"
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-3000}"
export WEATHERMETARS_DB_PATH="${WEATHERMETARS_DB_PATH:-$APP_DATA_DIR/weather-metars.sqlite}"
export WEATHERMETARS_RAW_DIR="${WEATHERMETARS_RAW_DIR:-$APP_DATA_DIR/raw-metars}"

mkdir -p "$(dirname "$WEATHERMETARS_DB_PATH")" "$WEATHERMETARS_RAW_DIR"

NODE_ENV=development bun install --frozen-lockfile
NODE_ENV=production bun run build

run_root systemctl daemon-reload
run_root systemctl restart "${SERVICE_PREFIX}-web.service"
run_root systemctl restart "${SERVICE_PREFIX}-worker.service"

health_host="$HOST"
if [ "$health_host" = "0.0.0.0" ] || [ "$health_host" = "::" ]; then
  health_host="127.0.0.1"
fi

if command -v curl >/dev/null 2>&1; then
  for _ in $(seq 1 20); do
    if curl -fsS "http://${health_host}:${PORT}/" >/dev/null; then
      exit 0
    fi
    sleep 1
  done
fi

run_root journalctl -u "${SERVICE_PREFIX}-web.service" -n 80 --no-pager
exit 1
