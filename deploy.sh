#!/usr/bin/env bash
# Deploy Saturn to the Raspberry Pi (saturn.local). rsync the source, build on
# the Pi (same aarch64, so native deps compile in place), restart the service.
#
# The build runs with /etc/saturn/saturn.env loaded because Next bakes
# NODE_ENV-time config (e.g. the CSP in next.config.ts) and some modules read
# env at import during prerender.
set -euo pipefail

PI="${PI:-lucas@saturn.local}"
APP=/srv/saturn/app

cd "$(dirname "$0")"

# --- apply the idempotent app schema before shipping code ---------------------
# db/setup.sql is safe to re-run (CREATE ... IF NOT EXISTS + drop/add constraint
# re-declarations), so running it every deploy means a fresh machine or a
# schema-changing release never boots against an un-migrated DB — the manual step
# is gone. Skip with SKIP_DB_MIGRATE=1. DATABASE_URL comes from the environment,
# or is read from .env.local when unset (quote-stripped by hand — the Neon URL
# contains '&', which breaks `source`). Neon is reachable from anywhere, so this
# runs from the dev box, not the Pi.
if [[ "${SKIP_DB_MIGRATE:-0}" != "1" ]]; then
  if [[ -z "${DATABASE_URL:-}" && -f .env.local ]]; then
    DATABASE_URL="$(sed -nE 's/^DATABASE_URL=//p' .env.local | head -1 | sed -E 's/^"//; s/"$//')"
  fi
  if [[ -n "${DATABASE_URL:-}" ]] && command -v psql >/dev/null 2>&1; then
    echo ">> applying db/setup.sql (idempotent) to the app database"
    psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q -f db/setup.sql
  else
    echo "!! skipping DB migration — no psql or DATABASE_URL. Run manually:" >&2
    echo "   psql \"\$DATABASE_URL\" -f db/setup.sql" >&2
  fi
fi

echo ">> rsync source to ${PI}:${APP}"
rsync -az --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude .next \
  --exclude '.env*' \
  --exclude deploy.sh \
  ./ "${PI}:${APP}/"

echo ">> npm ci + build on Pi (this is slow on a Pi 4)"
ssh "$PI" "set -euo pipefail
  cd ${APP}
  npm ci --no-audit --no-fund
  set -a; . /etc/saturn/saturn.env; set +a
  npm run build
  # the only path 'next start' writes; the service runs as user 'saturn'
  sudo install -d -o saturn -g saturn ${APP}/.next/cache
  sudo install -m 644 ${APP}/deploy/saturn.service /etc/systemd/system/saturn.service
  sudo systemctl daemon-reload
  # retire the old external saturn-events deliverer if this Pi still has it
  # (event delivery + scheduling run in-process now)
  sudo systemctl disable --now saturn-events 2>/dev/null || true
  sudo rm -f /etc/systemd/system/saturn-events.service
  sudo systemctl restart saturn
  sleep 2
  systemctl is-active saturn
  systemctl --no-pager --lines=6 status saturn | tail -6"

echo ">> deployed."
