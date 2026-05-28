# Deployment

This repo is set up for a single Hetzner VPS running behind Cloudflare.

The deploy workflow keeps credentials out of git:

- GitHub Actions stores only SSH deploy credentials in the `production` environment secrets.
- Runtime app config stays on the server in `/etc/weathermetars/weathermetars.env`.
- SQLite and raw METAR files live on the mounted Hetzner volume.

## Server Layout

Defaults used by the scripts:

```text
App directory:      /opt/weathermetars/app
Data directory:     /mnt/weathermetars
Runtime env file:   /etc/weathermetars/weathermetars.env
Web service:        weathermetars-web.service
Worker service:     weathermetars-worker.service
Local web port:     127.0.0.1:3000
```

Set `APP_DATA_DIR` to the mounted Hetzner volume path, for example:

```bash
APP_DATA_DIR=/mnt/HC_Volume_123456/weathermetars
```

## One-Time VPS Setup

Install base packages, create or choose a deploy user, and install Bun for that user. On Debian/Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y curl unzip rsync nginx
sudo adduser --disabled-password --gecos "" deploy
sudo -iu deploy
curl -fsSL https://bun.sh/install | bash
exit
```

Copy the deploy user's SSH public key into `/home/deploy/.ssh/authorized_keys`.

Then run the setup script from a checkout of this repo:

```bash
sudo APP_USER=deploy \
  APP_DATA_DIR=/mnt/HC_Volume_123456/weathermetars \
  APP_DOMAIN=weather.example.com \
  INSTALL_SUDOERS=1 \
  ./deploy/setup-vps.sh
```

Edit `/etc/weathermetars/weathermetars.env` after setup, especially `AWC_USER_AGENT`.

If `APP_DOMAIN` is set and Nginx is installed, setup installs an HTTPS reverse proxy to the Bun app after the Cloudflare Origin Certificate files exist on the VPS.

## SSL for weathermetars.com

Use Cloudflare for the public visitor-facing certificate, and use the VPS only for the origin certificate.

Do not store TLS private keys in GitHub secrets or in this repository. GitHub Actions only needs SSH credentials for deployment.

Recommended setup:

1. In Cloudflare DNS, create proxied `A`/`AAAA` records for `weathermetars.com` and `www.weathermetars.com` pointing at the Hetzner VPS.
2. In Cloudflare, create an Origin CA certificate for `weathermetars.com` and `*.weathermetars.com`.
3. On the VPS, save the certificate and key:

```bash
sudo install -d -m 700 /etc/ssl/cloudflare
sudo nano /etc/ssl/cloudflare/weathermetars.com.pem
sudo nano /etc/ssl/cloudflare/weathermetars.com.key
sudo chmod 600 /etc/ssl/cloudflare/weathermetars.com.*
```

4. Run setup with the domain and actual Hetzner volume path:

```bash
sudo APP_USER=deploy \
  APP_DATA_DIR=/mnt/HC_Volume_123456/weathermetars \
  APP_DOMAIN=weathermetars.com \
  SSL_CERT_FILE=/etc/ssl/cloudflare/weathermetars.com.pem \
  SSL_KEY_FILE=/etc/ssl/cloudflare/weathermetars.com.key \
  INSTALL_SUDOERS=1 \
  ./deploy/setup-vps.sh
```

5. In Cloudflare SSL/TLS, set encryption mode to `Full (strict)`.
6. Enable `Always Use HTTPS` in Cloudflare, or leave the included Nginx port 80 redirect in place as the origin fallback.

Cloudflare Origin CA certificates are trusted by Cloudflare, not by normal browsers. That is expected. Keep the DNS records proxied through Cloudflare unless you switch the VPS certificate to a public CA certificate such as Let's Encrypt.

Optional hardening after the site is stable:

- Enable Authenticated Origin Pulls in Cloudflare and Nginx.
- Restrict the Hetzner firewall to Cloudflare IP ranges for ports 80 and 443, plus your own IP for SSH.
- Redirect `www.weathermetars.com` to `weathermetars.com` in Cloudflare Rules or with a separate Nginx server block.

## GitHub Secrets

Create a GitHub environment named `production` and add:

```text
DEPLOY_HOST        VPS IP or DNS name
DEPLOY_USER        SSH deploy user, for example deploy
DEPLOY_SSH_KEY     Private ed25519 key for that deploy user
```

Recommended:

```text
DEPLOY_KNOWN_HOSTS Output of: ssh-keyscan -H <host>
```

Optional overrides:

```text
DEPLOY_PORT            Defaults to 22
DEPLOY_PATH            Defaults to /opt/weathermetars/app
DEPLOY_DATA_DIR        Defaults to /mnt/weathermetars
DEPLOY_ENV_FILE        Defaults to /etc/weathermetars/weathermetars.env
DEPLOY_SERVICE_PREFIX  Defaults to weathermetars
```

Generate a deploy key locally:

```bash
ssh-keygen -t ed25519 -C "github-actions weather-metars deploy" -f ./weathermetars_deploy
```

Put `weathermetars_deploy.pub` on the server and `weathermetars_deploy` in `DEPLOY_SSH_KEY`.

## Deploy Flow

`.github/workflows/deploy.yml` runs on pushes to `master` or `main`, and manually through `workflow_dispatch`.

The workflow:

1. Installs dependencies with Bun.
2. Runs typecheck, tests, and a production build.
3. Rsyncs source to the VPS while excluding local data, build output, and secrets.
4. Runs `deploy/remote-deploy.sh` on the VPS.

The remote script installs dependencies on the VPS, builds the Nitro/Bun output, restarts both systemd services, and checks the local web endpoint.
