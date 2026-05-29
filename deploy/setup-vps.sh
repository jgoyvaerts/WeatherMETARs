#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script with sudo or as root." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SERVICE_PREFIX="${SERVICE_PREFIX:-weathermetars}"
APP_USER="${APP_USER:-${SUDO_USER:-weathermetars}}"
APP_GROUP="${APP_GROUP:-$(id -gn "$APP_USER" 2>/dev/null || true)}"
APP_DIR="${APP_DIR:-/opt/weathermetars/app}"
APP_DATA_DIR="${APP_DATA_DIR:-/mnt/weathermetars}"
APP_ENV_FILE="${APP_ENV_FILE:-/etc/weathermetars/weathermetars.env}"
APP_HOST="${APP_HOST:-127.0.0.1}"
APP_PORT="${APP_PORT:-3000}"
APP_DOMAIN="${APP_DOMAIN:-}"
SSL_CERT_FILE="${SSL_CERT_FILE:-/etc/ssl/cloudflare/${APP_DOMAIN}.pem}"
SSL_KEY_FILE="${SSL_KEY_FILE:-/etc/ssl/cloudflare/${APP_DOMAIN}.key}"
INSTALL_SUDOERS="${INSTALL_SUDOERS:-0}"

if ! id "$APP_USER" >/dev/null 2>&1; then
  echo "User '$APP_USER' does not exist. Create the deploy user first or pass APP_USER=<user>." >&2
  exit 1
fi

if [ -z "$APP_GROUP" ]; then
  APP_GROUP="$(id -gn "$APP_USER")"
fi

APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
BUN_BIN="${BUN_BIN:-$APP_HOME/.bun/bin/bun}"

for required_tool in node python3 make g++; do
  if ! command -v "$required_tool" >/dev/null 2>&1; then
    echo "Missing required build tool: $required_tool" >&2
    echo "Install Node 22, build-essential, and python3 before running setup." >&2
    exit 1
  fi
done

if ! node -e "const major = Number(process.versions.node.split('.')[0]); process.exit(major >= 22 ? 0 : 1)" >/dev/null 2>&1; then
  echo "Node 22 or newer is required for node-gyp. Current version: $(node --version)" >&2
  exit 1
fi

sed_escape() {
  printf '%s' "$1" | sed -e 's/[#&\\]/\\&/g'
}

render_template() {
  local template="$1"
  sed \
    -e "s#__APP_USER__#$(sed_escape "$APP_USER")#g" \
    -e "s#__APP_GROUP__#$(sed_escape "$APP_GROUP")#g" \
    -e "s#__APP_DIR__#$(sed_escape "$APP_DIR")#g" \
    -e "s#__APP_DATA_DIR__#$(sed_escape "$APP_DATA_DIR")#g" \
    -e "s#__APP_ENV_FILE__#$(sed_escape "$APP_ENV_FILE")#g" \
    -e "s#__APP_PORT__#$(sed_escape "$APP_PORT")#g" \
    -e "s#__APP_DOMAIN__#$(sed_escape "$APP_DOMAIN")#g" \
    -e "s#__SSL_CERT_FILE__#$(sed_escape "$SSL_CERT_FILE")#g" \
    -e "s#__SSL_KEY_FILE__#$(sed_escape "$SSL_KEY_FILE")#g" \
    -e "s#__BUN_BIN__#$(sed_escape "$BUN_BIN")#g" \
    "$template"
}

install -d -o "$APP_USER" -g "$APP_GROUP" -m 755 "$APP_DIR"
install -d -o "$APP_USER" -g "$APP_GROUP" -m 750 "$APP_DATA_DIR"
install -d -o "$APP_USER" -g "$APP_GROUP" -m 750 "$APP_DATA_DIR/raw-metars"
install -d -o root -g "$APP_GROUP" -m 750 "$(dirname "$APP_ENV_FILE")"

if [ ! -f "$APP_ENV_FILE" ]; then
  cat > "$APP_ENV_FILE" <<EOF
NODE_ENV=production
HOST=$APP_HOST
PORT=$APP_PORT
WEATHERMETARS_DB_PATH=$APP_DATA_DIR/weather-metars.sqlite
WEATHERMETARS_RAW_DIR=$APP_DATA_DIR/raw-metars
AWC_USER_AGENT="WeatherMetars/0.1 (contact: ops@example.com)"
EOF
  chown root:"$APP_GROUP" "$APP_ENV_FILE"
  chmod 640 "$APP_ENV_FILE"
fi

render_template "$SCRIPT_DIR/systemd/weathermetars-web.service.template" \
  > "/etc/systemd/system/${SERVICE_PREFIX}-web.service"
render_template "$SCRIPT_DIR/systemd/weathermetars-worker.service.template" \
  > "/etc/systemd/system/${SERVICE_PREFIX}-worker.service"

systemctl daemon-reload
systemctl enable "${SERVICE_PREFIX}-web.service" "${SERVICE_PREFIX}-worker.service"

if [ -n "$APP_DOMAIN" ] && [ -d /etc/nginx/sites-available ] && [ -d /etc/nginx/sites-enabled ]; then
  if [ ! -f "$SSL_CERT_FILE" ] || [ ! -f "$SSL_KEY_FILE" ]; then
    echo "Skipping Nginx site install because the SSL certificate files do not exist yet:" >&2
    echo "  $SSL_CERT_FILE" >&2
    echo "  $SSL_KEY_FILE" >&2
    echo "Install a Cloudflare Origin Certificate and re-run this script." >&2
  else
    render_template "$SCRIPT_DIR/nginx/weathermetars.conf.template" \
      > "/etc/nginx/sites-available/${SERVICE_PREFIX}.conf"
    ln -sfn "/etc/nginx/sites-available/${SERVICE_PREFIX}.conf" \
      "/etc/nginx/sites-enabled/${SERVICE_PREFIX}.conf"
    nginx -t
    systemctl reload nginx
  fi
fi

if [ "$INSTALL_SUDOERS" = "1" ]; then
  systemctl_path="$(command -v systemctl)"
  journalctl_path="$(command -v journalctl)"
  cat > "/etc/sudoers.d/${SERVICE_PREFIX}-deploy" <<EOF
$APP_USER ALL=(root) NOPASSWD: $systemctl_path daemon-reload
$APP_USER ALL=(root) NOPASSWD: $systemctl_path restart ${SERVICE_PREFIX}-web.service
$APP_USER ALL=(root) NOPASSWD: $systemctl_path restart ${SERVICE_PREFIX}-worker.service
$APP_USER ALL=(root) NOPASSWD: $journalctl_path -u ${SERVICE_PREFIX}-web.service -n 80 --no-pager
EOF
  chmod 440 "/etc/sudoers.d/${SERVICE_PREFIX}-deploy"
  visudo -cf "/etc/sudoers.d/${SERVICE_PREFIX}-deploy" >/dev/null
fi

if [ ! -x "$BUN_BIN" ]; then
  echo "Bun was not found at $BUN_BIN. Install Bun for '$APP_USER' before the first deploy." >&2
fi

cat <<EOF
VPS setup complete.

App directory: $APP_DIR
Data directory: $APP_DATA_DIR
Environment file: $APP_ENV_FILE
Services: ${SERVICE_PREFIX}-web.service, ${SERVICE_PREFIX}-worker.service
EOF
