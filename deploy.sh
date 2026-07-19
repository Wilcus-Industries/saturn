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
  sudo systemctl restart saturn
  sleep 2
  systemctl is-active saturn
  systemctl --no-pager --lines=6 status saturn | tail -6
  # event deliverer (after the app so its first poll succeeds)
  sudo install -m 644 ${APP}/deploy/saturn-events.service /etc/systemd/system/saturn-events.service
  sudo systemctl daemon-reload
  sudo systemctl enable saturn-events
  sudo systemctl restart saturn-events
  sleep 2
  systemctl is-active saturn-events"

echo ">> deployed."
