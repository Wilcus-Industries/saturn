#!/usr/bin/env bash
# Saturn local self-host installer (SELF_HOSTED=1 single-owner mode).
#
# One-liner (clones to ~/saturn, then continues inside the checkout):
#   curl -fsSL https://raw.githubusercontent.com/Wilcus-Industries/saturn/main/install.sh | bash
# or run `bash install.sh` from inside an existing checkout (skips the clone).
#
# What it does, in order: platform + prereq checks (Node 22+, git, npm, psql,
# openssl — check-only, never installs system packages) → clone/reuse repo →
# pick a Postgres database (local server or pasted URL; verifies pgvector) →
# write .env.local (secrets auto-generated) → npm ci → db/setup.sql +
# better-auth migrate → next build → optional background service (macOS
# LaunchAgent / Linux systemd --user unit) → health check + summary.
#
# Flags (curl-piped: `bash -s -- <flags>`):
#   --dir <path>      install/clone directory (default ~/saturn, env SATURN_DIR)
#   --branch <name>   checkout this branch after clone (testing unmerged work)
#   --no-service      skip the background service, just build
#
# Prompts read from /dev/tty so the script stays interactive under curl|bash.
# Without a tty it falls back to safe defaults and aborts where a decision is
# genuinely required (e.g. no DATABASE_URL and no local Postgres).
set -euo pipefail

REPO_URL="https://github.com/Wilcus-Industries/saturn.git"
APP_DIR="${SATURN_DIR:-$HOME/saturn}"
DIR_SET="${SATURN_DIR:+1}"
BRANCH=""
INSTALL_SERVICE=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) APP_DIR="$2"; DIR_SET=1; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --no-service) INSTALL_SERVICE=0; shift ;;
    -h|--help) sed -n '2,22p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "unknown flag: $1 (see --help)" >&2; exit 1 ;;
  esac
done

say()  { echo ">> $*"; }
die()  { echo "!! $*" >&2; exit 1; }

# ---- interactivity ----------------------------------------------------------
# stdin is the pipe under curl|bash, so every prompt goes through /dev/tty.
# -r/-w only test permission bits — a process without a controlling terminal
# still passes them and then dies on read, so actually try opening it.
HAS_TTY=0
if { : < /dev/tty; } 2>/dev/null; then HAS_TTY=1; fi

# prompt VAR "message" "default" [silent]
prompt() {
  local __var="$1" msg="$2" def="${3:-}" silent="${4:-}" input=""
  if [[ $HAS_TTY -eq 1 ]]; then
    if [[ -n "$silent" ]]; then
      read -r -s -p "$msg" input < /dev/tty; echo >&2
    else
      read -r -p "$msg" input < /dev/tty
    fi
  fi
  printf -v "$__var" '%s' "${input:-$def}"
}

# confirm "message" default(y|n) — returns 0 for yes
confirm() {
  local msg="$1" def="$2" ans=""
  if [[ $HAS_TTY -eq 0 ]]; then [[ "$def" == y ]]; return; fi
  read -r -p "$msg [$([[ "$def" == y ]] && echo Y/n || echo y/N)] " ans < /dev/tty
  ans="${ans:-$def}"
  [[ "$ans" == [yY]* ]]
}

# ---- 1. platform ------------------------------------------------------------
OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) ;;
  *) die "unsupported platform: $OS (Windows: run inside WSL)" ;;
esac

# ---- 2. prereqs (check-only) ------------------------------------------------
missing=0
need() { # need <cmd> "<hint>"
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "!! missing: $1 — $2" >&2; missing=1
  fi
}
need git "install via your package manager (brew install git / apt install git)"
need node "Node.js 22+ required — https://nodejs.org or 'brew install node@22' / nvm / nodesource"
need npm "ships with Node.js — fix the Node install above"
need psql "Postgres client, used for migrations — 'brew install postgresql@17' / 'apt install postgresql-client'"
need openssl "used to generate secrets — install via your package manager"
[[ $missing -eq 0 ]] || die "install the missing prerequisites and re-run"

NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
[[ "$NODE_MAJOR" -ge 22 ]] || die "Node $(node -v) too old — Saturn needs Node 22+ (nvm install 22 / brew install node@22)"

# ---- 3. repo: reuse the checkout we're in, or clone -------------------------
# Running from inside a checkout (bash install.sh, or curl|bash with cwd in the
# repo) reuses it; otherwise clone to $APP_DIR. An explicit --dir/SATURN_DIR
# always wins over reuse-detection — passing it means "install THERE".
existing_root=""
if [[ -z "$DIR_SET" && -f "${BASH_SOURCE[0]:-}" ]]; then
  candidate="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [[ -f "$candidate/db/setup.sql" ]] && existing_root="$candidate"
fi
if [[ -z "$DIR_SET" && -z "$existing_root" ]]; then
  candidate="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  [[ -n "$candidate" && -f "$candidate/db/setup.sql" ]] && existing_root="$candidate"
fi

if [[ -n "$existing_root" ]]; then
  APP_DIR="$existing_root"
  say "using existing checkout: $APP_DIR"
elif [[ -d "$APP_DIR/.git" && -f "$APP_DIR/db/setup.sql" ]]; then
  say "found existing Saturn checkout at $APP_DIR"
  if confirm "   git pull latest?" y; then git -C "$APP_DIR" pull --ff-only; fi
elif [[ -e "$APP_DIR" ]]; then
  die "$APP_DIR exists and is not a Saturn checkout — pick another --dir"
else
  say "cloning $REPO_URL → $APP_DIR"
  git clone --depth 1 ${BRANCH:+--branch "$BRANCH"} "$REPO_URL" "$APP_DIR"
fi
if [[ -n "$BRANCH" ]]; then
  git -C "$APP_DIR" rev-parse --verify -q "$BRANCH" >/dev/null 2>&1 || git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH:$BRANCH" 2>/dev/null || true
  git -C "$APP_DIR" checkout "$BRANCH"
fi
cd "$APP_DIR"

# ---- 4. database ------------------------------------------------------------
DB_URL="${DATABASE_URL:-}"
if [[ -n "$DB_URL" ]]; then
  say "using DATABASE_URL from environment"
elif [[ -f .env.local ]] && grep -q '^DATABASE_URL=..*' .env.local; then
  # re-run over an existing install: the previous wizard already picked a DB
  DB_URL="$(sed -nE 's/^DATABASE_URL=//p' .env.local | head -1 | sed -E 's/^"//; s/"$//')"
  say "using DATABASE_URL from existing .env.local"
elif command -v pg_isready >/dev/null 2>&1 && pg_isready -q 2>/dev/null; then
  say "local Postgres server detected"
  if confirm "   create/use local database 'saturn'?" y; then
    if ! psql -d saturn -c 'select 1' >/dev/null 2>&1; then
      createdb saturn || die "createdb saturn failed"
      say "created database 'saturn'"
    fi
    DB_URL="postgresql://localhost/saturn"
  fi
fi
if [[ -z "$DB_URL" ]]; then
  [[ $HAS_TTY -eq 1 ]] || die "no DATABASE_URL and no local Postgres — export DATABASE_URL and re-run"
  prompt DB_URL "Paste a Postgres connection URL (any Postgres with pgvector): "
  [[ -n "$DB_URL" ]] || die "a database is required"
fi

psql "$DB_URL" -c 'select 1' >/dev/null 2>&1 || die "cannot connect to database: $DB_URL"
# pgvector must be installable before we run db/setup.sql (memory_item embeddings)
if ! psql "$DB_URL" -tA -c "select 1 from pg_available_extensions where name='vector'" 2>/dev/null | grep -q 1; then
  die "pgvector extension not available on that server — install it first:
   macOS:  brew install pgvector   (then restart Postgres)
   Debian: sudo apt install postgresql-<version>-pgvector"
fi
say "database OK (pgvector available)"

# ---- 5. env wizard → .env.local ---------------------------------------------
PORT=3000
MCP_TOKEN=""
if [[ -f .env.local ]]; then
  say ".env.local already exists"
  if confirm "   keep it as-is (n = rewrite it)?" y; then
    # pull what later steps need out of the kept file
    DB_URL="$(sed -nE 's/^DATABASE_URL=//p' .env.local | head -1 | sed -E 's/^"//; s/"$//')"
    [[ -n "$DB_URL" ]] || die ".env.local has no DATABASE_URL — rewrite it (re-run and answer n)"
    PORT="$(sed -nE 's#^BETTER_AUTH_URL=http://localhost:([0-9]+).*#\1#p' .env.local | head -1)"
    PORT="${PORT:-3000}"
    MCP_TOKEN="$(sed -nE 's/^SELF_HOSTED_MCP_TOKEN=//p' .env.local | head -1)"
    WRITE_ENV=0
  else
    WRITE_ENV=1
  fi
else
  WRITE_ENV=1
fi

if [[ "${WRITE_ENV}" -eq 1 ]]; then
  prompt PORT "Port to serve on [3000]: " 3000
  [[ "$PORT" =~ ^[0-9]+$ ]] || die "invalid port: $PORT"
  # optional — sole funding path for model/agent/memory features in
  # SELF_HOSTED mode (no per-user BYOK); blank = those features stay off
  prompt OR_KEY "OpenRouter API key (blank = agent/model/memory features disabled): " "" silent
  AUTH_SECRET="$(openssl rand -base64 32)"
  MCP_TOKEN="$(openssl rand -hex 32)"
  umask 177
  cat > .env.local <<EOF
# generated by install.sh $(date -u +%Y-%m-%dT%H:%M:%SZ) — SELF_HOSTED single-owner mode
SELF_HOSTED=1
DATABASE_URL=$DB_URL
BETTER_AUTH_URL=http://localhost:$PORT
BETTER_AUTH_SECRET=$AUTH_SECRET
PLATFORM_OPENROUTER_KEY=$OR_KEY
SELF_HOSTED_MCP_TOKEN=$MCP_TOKEN
EOF
  umask 022
  chmod 600 .env.local
  say "wrote .env.local (chmod 600)"
fi

# ---- 6. install + migrate ---------------------------------------------------
say "npm ci"
npm ci

say "applying db/setup.sql (idempotent)"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f db/setup.sql

# SELF_HOSTED=1 must be set so the stripe plugin (and its subscription table)
# is consistently absent from the generated schema; DATABASE_URL passed
# explicitly — the better-auth CLI doesn't read .env.local.
say "creating better-auth tables"
SELF_HOSTED=1 DATABASE_URL="$DB_URL" npx --yes @better-auth/cli@latest migrate --config lib/auth.ts -y

# ---- 7. build ---------------------------------------------------------------
say "building (next build)"
npm run build

# ---- 8. background service --------------------------------------------------
NPM_BIN="$(command -v npm)"
NODE_DIR="$(dirname "$(command -v node)")"
SERVICE_INSTALLED=0

if [[ $INSTALL_SERVICE -eq 1 ]] && confirm "Install a background service so Saturn starts on login and restarts on crash?" y; then
  if [[ "$OS" == "Darwin" ]]; then
    PLIST="$HOME/Library/LaunchAgents/com.wilcus.saturn.plist"
    LOG_DIR="$HOME/Library/Logs/saturn"
    mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.wilcus.saturn</string>
  <key>ProgramArguments</key><array>
    <string>$NPM_BIN</string><string>start</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$NODE_DIR:/usr/local/bin:/usr/bin:/bin</string>
    <key>PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/saturn.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/saturn.err.log</string>
</dict></plist>
EOF
    launchctl bootout "gui/$(id -u)/com.wilcus.saturn" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
    SERVICE_INSTALLED=1
    say "LaunchAgent installed ($PLIST) — logs in $LOG_DIR"
  else
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/saturn.service" <<EOF
[Unit]
Description=Saturn (self-hosted)
After=network.target

[Service]
ExecStart=$NPM_BIN start
WorkingDirectory=$APP_DIR
Environment=PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin
Environment=PORT=$PORT
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now saturn
    SERVICE_INSTALLED=1
    say "systemd user unit installed — journalctl --user -u saturn -f"
    say "tip: 'loginctl enable-linger $USER' keeps it running without an open session"
  fi
fi

# ---- 9. health check + summary ----------------------------------------------
if [[ $SERVICE_INSTALLED -eq 1 ]]; then
  say "waiting for http://localhost:$PORT ..."
  ok=0
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null "http://localhost:$PORT"; then ok=1; break; fi
    sleep 2
  done
  if [[ $ok -eq 1 ]]; then
    say "Saturn is up: http://localhost:$PORT"
  else
    say "service installed but not answering yet — check logs (above) before assuming failure"
  fi
fi

echo
echo "============================================================"
echo " Saturn installed (SELF_HOSTED single-owner mode)"
echo "============================================================"
echo " App dir:    $APP_DIR"
echo " Dashboard:  http://localhost:$PORT"
if [[ $SERVICE_INSTALLED -eq 0 ]]; then
  echo " Start it:   cd $APP_DIR && PORT=$PORT npm start"
fi
if [[ -n "$MCP_TOKEN" ]]; then
  echo
  echo " Connect an agent to the hosted MCP server:"
  echo "   claude mcp add --transport http saturn http://localhost:$PORT/mcp \\"
  echo "     --header \"Authorization: Bearer $MCP_TOKEN\""
fi
echo
echo " SECURITY: the dashboard has NO authentication in self-hosted mode."
echo " Anyone who can reach port $PORT is the owner. Keep it on localhost,"
echo " or front it with reverse-proxy auth before exposing it."
echo
echo " Optional (Linux only): agent sandboxes need a one-time provisioning"
echo " step — see deploy/README.md + deploy/setup-sandboxes.sh."
echo "============================================================"
