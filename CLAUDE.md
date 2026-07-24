# CLAUDE.md

File guides Claude Code (claude.ai/code) working with code in this repo.

@AGENTS.md

> **Keep this current:** a change altering anything documented here or in `docs/` (routes, commands, schema, conventions, tier logic, env vars, invariants) → update the matching section or doc in the same change. Detail lives in `docs/`; this file stays an index plus the things that must hold everywhere.

## Docs

Subsystem detail lives in `docs/` — read the one your task touches, not all of them.

| file | covers |
|---|---|
| `docs/auth-billing.md` | better-auth config, OAuth + MCP consent, tiers and `PLAN_LIMITS`, Stripe, self-hosted mode, user flow, model credits + BYOK funding |
| `docs/ui.md` | route groups (landing scene, dashboard shell, Agent chat page), SEO/metadata/indexing |
| `docs/registry.md` | `registry_entry` — MCP servers, skills, memory stores, sandboxes, variables; MCP discovery/OAuth; how each becomes a designer node |
| `docs/workflows.md` | `workflow`/`workflow_run` schema, list page, cron scheduler + runner, interpreter and test runs |
| `docs/designer.md` | designer canvas: gestures, toolbox, popovers, validation surfacing, agent panel, `geometry.ts` |
| `docs/nodes.md` | node catalog (`lib/workflow.ts`) + the Saturn (`agent`) node, grants, memory/sandbox tools |
| `docs/integrations.md` | integration action nodes (Discord/Telegram/HTTP) + extension event nodes and their ingress (Gateway, poller, GitHub App webhook, inbound webhooks) |
| `docs/mcp-server.md` | hosted `/mcp` Streamable-HTTP server and its 35 tools |
| `deploy/README.md` | fresh-machine runbook (host bootstrap → `deploy.sh` → `setup-sandboxes.sh`) |
| `deploy/sandboxes.md` | sandbox host ops detail |

## Commands

- `npm run dev` — dev server at http://localhost:3000 (no background loops)
- `npm run dev:full` — dev server **with** background work (`SATURN_DEV_BACKGROUND=1` loosens `instrumentation.ts` gate: scheduler + Discord gateway + Telegram poller + sandbox reaper). Only against dev DB branch — prod bot tokens in active workflows would fight prod (Telegram getUpdates single-consumer 409s, Discord double-delivery). GitHub events aren't a background transport (they arrive via the `/api/github/webhook` HTTP route), so nothing to fight there
- `scripts/dev-db.sh create|reset` — create/reset Neon `dev` branch from prod state via `neonctl` (`neonctl auth` once; `NEON_PROJECT_ID` defaults to the Saturn project), then **deactivates every workflow** on the branch (bot-token safety, above) and prints pooled `DATABASE_URL` for `.env.local`. `.env.local` is **dev-only** (dev branch URL, localhost, test keys) — prod env lives solely in `/etc/saturn/saturn.env` on the Pi
- `npm run build` — production build
- `npm run lint` — ESLint
- `psql "$DATABASE_URL" -f db/setup.sql` — create app tables (idempotent). Enables `vector` extension (pgvector, **required** for `memory_item` embeddings), re-applies CHECK-constraint widenings via `drop constraint if exists` + `add constraint` (`workflow_run_trigger_check` and `model_usage_source_check` include `'event'`; `registry_entry` kind CHECK includes `'memory'`, `'variable'`, `'sandbox'`) — must run before deploying code that writes those values. Also creates `github_installation` (central GitHub App installation → Saturn user mapping, `installation_id` pk + `user_id` FK cascade + `account_login`; see `docs/integrations.md`), and adds the nullable `workflow.webhook_secret` column (per-workflow inbound webhook capability secret; `add column if not exists`). Rarely run by hand: **`deploy.sh` applies automatically every deploy** (reads `DATABASE_URL` from env, else ssh-reads it from the Pi's `/etc/saturn/saturn.env` — never `.env.local`, which is dev-only; `SKIP_DB_MIGRATE=1` opts out).
- `npx @better-auth/cli@latest migrate --config lib/auth.ts` — create/update better-auth-owned tables (needed once for mcp plugin's `oauthApplication`/`oauthAccessToken`/`oauthConsent`; `generate` first to review SQL)
- `install.sh` — curl-able local self-host installer (`curl -fsSL https://raw.githubusercontent.com/Wilcus-Industries/saturn/main/install.sh | bash`), macOS/Linux: prereq checks (Node 22+/git/npm/psql/openssl — check-only, never installs system packages), clone-or-reuse checkout (dual-mode: run from inside a checkout skips clone), Postgres pick (local server → offer `createdb saturn`, else pasted `DATABASE_URL`; verifies pgvector availability), `.env.local` wizard for `SELF_HOSTED=1` mode (auto-generates `BETTER_AUTH_SECRET`/`SELF_HOSTED_MCP_TOKEN`, prompts port + optional `PLATFORM_OPENROUTER_KEY`), `npm ci` + both migrations (`db/setup.sql`, `SELF_HOSTED=1 … migrate -y`) + `next build`, then optional background service (macOS LaunchAgent `com.wilcus.saturn` logging to `~/Library/Logs/saturn/`, Linux systemd **user** unit `saturn.service`) + health check. Flags: `--dir` (default `~/saturn`, env `SATURN_DIR`), `--branch`, `--no-service`. Prompts read `/dev/tty` (works under curl|bash); no tty = safe defaults or abort. Idempotent re-run (keeps existing `.env.local` after confirm, re-parses `DATABASE_URL`/port/MCP token from it). Sandbox provisioning stays out of scope (`deploy/setup-sandboxes.sh`).
- No test suite.

Local Stripe webhooks: `stripe listen --forward-to localhost:3000/api/auth/stripe/webhook` (signing secret → `STRIPE_WEBHOOK_SECRET`). Required env vars documented in `.env.example`.

Production self-hosted on Raspberry Pi (hostname `saturn`, reachable `saturn.local`) behind Cloudflare Tunnel serving https://saturn.wilcus.com. `deploy.sh` applies `db/setup.sql` (above), rsyncs source to `/srv/saturn/app`, runs `npm ci` + `next build` on Pi, installs `deploy/saturn.service` (`next start` bound 127.0.0.1:3000, run as `saturn` system user, env in `/etc/saturn/saturn.env`), restarts `saturn` systemd service, retires leftover `saturn-events` unit — no external triggers anymore. **Fresh-machine runbook = `deploy/README.md`** (one-time host bootstrap → `deploy.sh` → optional `setup-sandboxes.sh`).

**Background work runs in-process** in production (`instrumentation.ts` → `lib/background.server.ts`, started once per server boot when `NODE_ENV === "production"` **or** `SATURN_DEV_BACKGROUND=1` (`npm run dev:full` dev opt-in) — never during builds (Next skips `register()` in build phase), never in plain `next dev`): per-minute cron scheduler (`lib/scheduler.server.ts` — self-arming :00-aligned tick calling `runDueWorkflows(minute)`, serialized in-process, missed-minute catch-up capped at 5 so sparse crons recover after stalls), Discord Gateway listener (`lib/gateway.server.ts`), Telegram long-poller (`lib/telegram.server.ts`) — see `docs/integrations.md` — and **sandbox idle reaper** (`startSandboxReaper` in `lib/sandbox.server.ts`, 60s sweep stopping containers idle > 5 min).

**Per-user sandboxes** run on rootless podman under dedicated `sandboxes` OS user (libpod REST at `SANDBOX_PODMAN_SOCKET`, e.g. `/run/sandboxes/podman.sock` — unset degrades every sandbox tool to value error "sandbox runtime not configured"). Host provisioning = one-time `deploy/setup-sandboxes.sh` (run once as root; idempotent, **self-verifying** — aborts unless socket-reachable + image-resolves + egress-contained, so broken host never enables feature — and **self-wiring**: sets `SANDBOX_PODMAN_SOCKET` in `saturn.env`, restarts saturn). Creates `sandboxes` user + subuid range, installs podman/pasta/uidmap, delegates cpu cgroups, fixes Pi firmware-disabled memory cgroup (appends `cgroup_enable=memory cgroup_memory=1` to `/boot/firmware/cmdline.txt`, aborts for reboot — without it every memory-limited container fails at start), relocates socket, installs nftables uid-keyed egress lockdown, adds `saturn.service.d/sandbox.conf` drop-in granting app `SupplementaryGroups=sandboxes` + `ReadWritePaths=/run/sandboxes`. Drop-in deliberately **not** in base `deploy/saturn.service`: grants reference host state that exists only post-provisioning — baking in would wedge every deploy to un-provisioned box (216/GROUP, 226/NAMESPACE). `deploy/Containerfile.sandbox` builds `saturn-sandbox:latest` Debian image; ops detail in `deploy/sandboxes.md`.

## Stack

Next.js 16 App Router (with `experimental.viewTransition`), React 19, Tailwind CSS 4 (no config file — theme, view-transition keyframes, tier glow utilities live in `app/globals.css`), TypeScript, better-auth + `@better-auth/stripe`, raw `pg` Pool against Neon Postgres (no ORM). Fonts: Geist + Geist Mono from `next/font/google`, loaded in `app/layout.tsx` (the `geist` **package** stays a dependency even though nothing imports it: `app/opengraph-image.tsx` reads `node_modules/geist/dist/fonts/geist-mono/GeistMono-Regular.ttf` at build time, a runtime path no type checker or linter can see).

`next.config.ts` sets global security headers via `headers()` (applied to `/:path*`): CSP (`default-src 'self'`; `script-src`/`style-src` allow `'unsafe-inline'` for Next inline bootstrap + designer inline styles; `img-src` allows `data:` + Google s2 favicons + avatar host; dev adds `'unsafe-eval'` + `ws:` for Fast Refresh/HMR — computed inside `headers()` so `NODE_ENV` resolved at bake time), plus `frame-ancestors 'none'`/`X-Frame-Options: DENY` (clickjacking, notably OAuth consent page), HSTS, `nosniff`, `Referrer-Policy`, minimal `Permissions-Policy`.

## Architecture map

Auth + billing is the spine: better-auth (`lib/auth.ts`) owns sessions, Google OAuth, the Stripe plugin, and — via its `mcp` plugin — the OAuth 2.1 authorization server the hosted `/mcp` endpoint authenticates against. `lib/subscription.ts` turns a session into an activation level, which gates every count cap and the cron floor.

On top of that sit **workflows**: a node graph (`graph` jsonb on `workflow`) authored in the full-screen designer and executed by one interpreter (`lib/interpreter.ts`) that is pure graph-walking with every side effect injected as a hook. The same interpreter runs client-side for designer test runs and server-side for real runs (`lib/runner.server.ts` `executeWorkflowRun`), so each hook has two wirings: a `requireUser()` server action in `app/dashboard/workflows/[id]/actions.ts` and an execute core in the runner.

Graphs trigger from **event nodes**. Scheduled ones fire from the in-process per-minute scheduler; real-time ones arrive over ingress transports (Discord Gateway, Telegram poller) or plain HTTP routes (GitHub App webhook, per-workflow inbound webhooks). What nodes exist comes from `lib/workflow.ts` plus the user's own registry (`lib/registry.ts` `buildUserCatalog` — MCP servers, skills, memory stores, sandboxes, variables), merged into one `byKey` map threaded through designer and interpreter alike.

`/mcp` is the same system with a different front door: external agents read and write those graphs and that registry through 35 JSON-RPC tools, as the authenticated user.

## Invariants

Things that break non-locally when violated. Reasoning lives in the linked doc.

**Deployment**

- In-process caches (`lib/cache.server.ts` TTL caches + better-auth session cookieCache) assume **single-process deployment** — remove/externalize before ever running more than one instance.

**Auth** (`docs/auth-billing.md`)

- `nextCookies` must stay last in the better-auth plugins array.
- Don't remove root `proxy.ts` or the mcp plugin's `consentPage` without replacing the consent gate — together they're the fix for a cross-account-takeover.
- Sessions resolve through `getSessionCached()` in `lib/subscription.ts`, never `auth.api.getSession` directly (the self-hosted synthetic owner depends on it).
- Tier logic comes from `lib/subscription.ts` only — never re-derive a level from a subscription row.
- better-auth owns its tables (`user`, `session`, `subscription`, `oauth*`) — migrate via its CLI, never redefine them in `db/setup.sql`.
- Under `SELF_HOSTED=1`: no code may run `subscription` SQL or call a stripe-plugin `auth.api` endpoint (neither exists), and no `"use client"` file may import `lib/selfhost` (server-only const, would inline `undefined`).
- Server actions are public POST endpoints — every one re-checks session itself via `requireUser()`.

**Secrets** (`docs/registry.md`)

- Write-only convention everywhere (MCP `auth_token`, `oauth`, variable values, OpenRouter key): blank keeps, checkbox clears, the client only ever sees a boolean. `getUserRegistry`'s SELECT never includes `auth_token` — keep it that way.
- Graphs and logs only ever carry the `{{var:<uuid>}}` sentinel; plaintext substitution happens server-side at the point of consumption (`executeIntegration`, `getEventSubscriptions`).

**Outbound fetch**

- Every fetch in `lib/mcp.ts` calls `assertPublicHttpsUrl` first — the server URL *and* every metadata-derived endpoint are attacker-influenceable. Never add one that skips it.
- Any new sender fetching an attacker-influenced URL follows `sendHttpRequest` in `lib/integrations.server.ts`: manual redirect loop re-validating each hop, header charset/CRLF checks, capped response, deadline.
- Per-provider senders keep untrusted config out of the fetch target — exact-host allowlists and strict id/token regexes, never substring checks.

**Cache coherence**

- Every registry mutation calls `invalidateUserRegistry(userId)`; every workflow or variable mutation also calls `subscriptionsChanged()` so transports reconnect.

**Module graph**

- `lib/integrations.ts` may only `import type` from `lib/workflow.ts` — a value import back cycles at runtime.
- `lib/seo.ts` and metadata routes must not import `lib/subscription.ts` — it drags auth/db/Stripe into their bundles.

**Designer rendering** (`docs/designer.md`, `docs/nodes.md`)

- `geometry.ts` is the single source of node metrics; `node.tsx` and `edges.tsx` must match it exactly — edge anchors are computed, never DOM-measured.
- A node box must never carry its frame as a real CSS `border` — ports anchor on the border box and every marker would shift inward. Paint frames with the `nodeFrame.tsx` inset overlay.
- Resolve node colors through `entryStyles(entry)`, never by indexing `CATEGORY_STYLES` with `entry.category`.
- `Node` and per-edge paths are memoized and read live state through refs — a new per-render prop on `Node` kills the memo.

**Copy sync**

- `TIERS` in `app/(saturn)/activate/tierCard.tsx` must stay in sync with `PLAN_LIMITS` and with the landing JSON-LD offer prices; its class strings must stay literal for Tailwind.
- A third UI cookie means updating the privacy page's cookie clause, which enumerates them.
- No em-dashes in marketing/SEO copy (meta descriptions, OG text, JSON-LD strings).

## Conventions

- Components colocate with the route that uses them (e.g. `app/dashboard/sidebar.tsx`); only cross-cutting code goes in `lib/`.
- Server actions return `{ error: string }` for expected user-facing failures and never throw — a thrown server-action error hits Next's generic error page, and prod redacts the message.
- Animations respect `prefers-reduced-motion` throughout (scene, moons, transitions, glows).
