#!/usr/bin/env bash
# Create or reset the Neon 'dev' branch used for local development.
#
# The branch is copy-on-write from prod, so it starts with prod data — including
# active workflows carrying real Discord/Telegram bot tokens. Left active, a
# local `npm run dev:full` server would fight prod for Telegram getUpdates
# (single consumer — 409s / stolen updates) and double-deliver Discord events.
# So after create/reset this script always deactivates every workflow on the
# branch; reactivate only what you're testing, preferably with dev bot tokens.
#
# One-time setup: `npx neonctl auth` (or export NEON_API_KEY). NEON_PROJECT_ID
# defaults to the Saturn project (override via env; `npx neonctl projects list`).
set -euo pipefail

NEON_PROJECT_ID="${NEON_PROJECT_ID:-plain-pine-44582311}"

case "${1:-}" in
  create)
    npx neonctl branches create --project-id "$NEON_PROJECT_ID" --name dev
    ;;
  reset)
    # restore the branch to the parent's (prod's) current state
    npx neonctl branches reset dev --project-id "$NEON_PROJECT_ID" --parent
    ;;
  *)
    echo "usage: $0 create|reset" >&2
    exit 1
    ;;
esac

DEV_URL="$(npx neonctl connection-string dev --project-id "$NEON_PROJECT_ID" --pooled)"

echo ">> deactivating all workflows on the dev branch (bot-token safety)"
psql "$DEV_URL" -v ON_ERROR_STOP=1 -q -c "update workflow set active=false;"

echo ">> dev branch ready. DATABASE_URL for .env.local:"
echo "$DEV_URL"
