# CLAUDE.md

File guides Claude Code (claude.ai/code) working with code in this repo.

@AGENTS.md

> **Keep this current:** a change altering anything documented here or in `docs/` (routes, commands, schema, conventions, tier logic, env vars, invariants) → update the matching section or doc in the same change. Detail lives in `docs/`; this file stays an index plus the things that must hold everywhere.

## Docs

Subsystem detail lives in `docs/` — read the one your task touches, not all of them.

> **`docs/` is stale.** The desktop pivot deleted the marketing site, sign-in/OAuth UI, billing + model-credits UI, the sandbox feature and every hosting artifact. The files under `docs/` still describe all of it. Trust the code over `docs/` until they are rewritten.

| file | covers |
|---|---|
| `docs/auth-billing.md` | better-auth config, OAuth + MCP consent, tiers and `PLAN_LIMITS`, Stripe, self-hosted mode, user flow, model credits + BYOK funding |
| `docs/ui.md` | route groups (dashboard shell, Agent chat page) |
| `docs/registry.md` | `registry_entry` — MCP servers, skills, memory stores, variables; MCP discovery/OAuth; how each becomes a designer node |
| `docs/workflows.md` | `workflow`/`workflow_run` schema, list page, cron scheduler + runner, interpreter and test runs |
| `docs/designer.md` | designer canvas: gestures, toolbox, popovers, validation surfacing, agent panel, `geometry.ts` |
| `docs/nodes.md` | node catalog (`lib/workflow.ts`) + the Saturn (`agent`) node, grants, memory tools |
| `docs/integrations.md` | integration action nodes (Discord/Telegram/HTTP) + extension event nodes and their ingress (Gateway, poller, GitHub App webhook) |
| `docs/mcp-server.md` | hosted `/mcp` Streamable-HTTP server and its 27 tools |

## Commands

- `npm run dev` — dev server at http://localhost:3000 (no background loops)
- `npm run dev:full` — dev server **with** background work (`SATURN_DEV_BACKGROUND=1` loosens `instrumentation.ts` gate: scheduler + Discord gateway + Telegram poller). Bot tokens are single-consumer, so two instances on the same DB fight (Telegram getUpdates 409s, Discord double-delivery). GitHub events aren't a background transport (they arrive via the `/api/github/webhook` HTTP route), so nothing to fight there
- `npm run build` — production build
- `npm run lint` — ESLint
- `psql "$DATABASE_URL" -f db/setup.sql` — create app tables (idempotent). Enables `vector` extension (pgvector, **required** for `memory_item` embeddings), re-applies CHECK-constraint widenings via `drop constraint if exists` + `add constraint` (`workflow_run_trigger_check` and `model_usage_source_check` include `'event'`; `registry_entry` kind CHECK includes `'memory'`, `'variable'`) — must run before deploying code that writes those values. Also creates `github_installation` (central GitHub App installation → Saturn user mapping, `installation_id` pk + `user_id` FK cascade + `account_login`; see `docs/integrations.md`). Run by hand — there is no deploy script anymore.
- `npx @better-auth/cli@latest migrate --config lib/auth.ts` — create/update better-auth-owned tables (needed once for mcp plugin's `oauthApplication`/`oauthAccessToken`/`oauthConsent`; `generate` first to review SQL)
- No test suite.

Required env vars documented in `.env.example`.

**No hosted deployment.** The Pi, Neon, Cloudflare Tunnel, Stripe, the GitHub App and Google OAuth were all decommissioned in the desktop pivot; `deploy.sh`, `install.sh`, `scripts/dev-db.sh` and the whole `deploy/` tree are gone. Point `DATABASE_URL` at any Postgres with pgvector and run locally.

**Background work runs in-process** in production (`instrumentation.ts` → `lib/background.server.ts`, started once per server boot when `NODE_ENV === "production"` **or** `SATURN_DEV_BACKGROUND=1` (`npm run dev:full` dev opt-in) — never during builds (Next skips `register()` in build phase), never in plain `next dev`): per-minute cron scheduler (`lib/scheduler.server.ts` — self-arming :00-aligned tick calling `runDueWorkflows(minute)`, serialized in-process, missed-minute catch-up capped at 5 so sparse crons recover after stalls), Discord Gateway listener (`lib/gateway.server.ts`), Telegram long-poller (`lib/telegram.server.ts`) — see `docs/integrations.md`.

## Stack

Next.js 16 App Router (with `experimental.viewTransition`), React 19, Tailwind CSS 4 (no config file — theme and animation keyframes live in `app/globals.css`), TypeScript, better-auth + `@better-auth/stripe`, raw `pg` Pool against Postgres (no ORM). Fonts: Geist + Geist Mono from `next/font/google`, loaded in `app/layout.tsx`.

`next.config.ts` sets global security headers via `headers()` (applied to `/:path*`): CSP (`default-src 'self'`; `script-src`/`style-src` allow `'unsafe-inline'` for Next inline bootstrap + designer inline styles; `img-src` allows `data:` + Google s2 favicons + avatar host; dev adds `'unsafe-eval'` + `ws:` for Fast Refresh/HMR — computed inside `headers()` so `NODE_ENV` resolved at bake time), plus `frame-ancestors 'none'`/`X-Frame-Options: DENY` (clickjacking), HSTS, `nosniff`, `Referrer-Policy`, minimal `Permissions-Policy`.

## Architecture map

Auth + billing is the spine: better-auth (`lib/auth.ts`) owns sessions, Google OAuth, the Stripe plugin, and — via its `mcp` plugin — the OAuth 2.1 authorization server the hosted `/mcp` endpoint authenticates against. `lib/subscription.ts` turns a session into an activation level, which gates every count cap and the cron floor.

On top of that sit **workflows**: a node graph (`graph` jsonb on `workflow`) authored in the full-screen designer and executed by one interpreter (`lib/interpreter.ts`) that is pure graph-walking with every side effect injected as a hook. The same interpreter runs client-side for designer test runs and server-side for real runs (`lib/runner.server.ts` `executeWorkflowRun`), so each hook has two wirings: a `requireUser()` server action in `app/dashboard/workflows/[id]/actions.ts` and an execute core in the runner.

Graphs trigger from **event nodes**. Scheduled ones fire from the in-process per-minute scheduler; real-time ones arrive over ingress transports (Discord Gateway, Telegram poller) or the GitHub App webhook route. What nodes exist comes from `lib/workflow.ts` plus the user's own registry (`lib/registry.ts` `buildUserCatalog` — MCP servers, skills, memory stores, variables), merged into one `byKey` map threaded through designer and interpreter alike.

`/mcp` is the same system with a different front door: external agents read and write those graphs and that registry through 35 JSON-RPC tools, as the authenticated user.

## Invariants

Things that break non-locally when violated. Reasoning lives in the linked doc.

**Deployment**

- In-process caches (`lib/cache.server.ts` TTL caches + better-auth session cookieCache) assume **single-process deployment** — remove/externalize before ever running more than one instance.

**Auth** (`docs/auth-billing.md`)

- `nextCookies` must stay last in the better-auth plugins array.
- The mcp plugin's `loginPage`/`consentPage` point at routes the pivot deleted, so hosted OAuth authorize now 404s — it fails **closed**. Don't "fix" that by dropping `consentPage`: without a consent screen the plugin issues a code silently to any anonymously registered client, which a Lax session cookie turns into cross-account token theft. Delete the whole mcp plugin (and root `proxy.ts`) instead.
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

**Designer rendering** (`docs/designer.md`, `docs/nodes.md`)

- `geometry.ts` is the single source of node metrics; `node.tsx` and `edges.tsx` must match it exactly — edge anchors are computed, never DOM-measured.
- A node box must never carry its frame as a real CSS `border` — ports anchor on the border box and every marker would shift inward. Paint frames with the `nodeFrame.tsx` inset overlay.
- Resolve node colors through `entryStyles(entry)`, never by indexing `CATEGORY_STYLES` with `entry.category`.
- `Node` and per-edge paths are memoized and read live state through refs — a new per-render prop on `Node` kills the memo.

## Conventions

- Components colocate with the route that uses them (e.g. `app/dashboard/sidebar.tsx`); only cross-cutting code goes in `lib/`.
- Server actions return `{ error: string }` for expected user-facing failures and never throw — a thrown server-action error hits Next's generic error page, and prod redacts the message.
- Animations respect `prefers-reduced-motion` throughout.
