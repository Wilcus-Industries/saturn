---
name: verify
description: How to run and verify Saturn changes end-to-end (dev server, auth, driving the dashboard)
---

# Verifying Saturn

## Launch

- The user usually already has `npm run dev` on http://localhost:3000 (starting a second instance errors with "Another next dev server is already running" and falls back to :3002 — check `curl -s -o /dev/null -w "%{http_code}" localhost:3000` first and reuse it; it hot-reloads your edits).
- Server log: `.next/dev/logs/next-development.log` (JSON lines; Browser + Server entries). Check timestamps — errors may predate your change.

## Database + background work

- Local dev runs against whatever Postgres `.env.local` DATABASE_URL points at. There is no prod anymore (the Pi/Neon/Cloudflare stack was decommissioned in the desktop pivot) and no `scripts/dev-db.sh` — write freely. Schema: `psql "$DATABASE_URL" -f db/setup.sql` (idempotent).
- Plain `npm run dev` never starts background loops (scheduler, Discord gateway, Telegram poller). To verify scheduled/event workflows use `npm run dev:full` (sets `SATURN_DEV_BACKGROUND=1`).

## Auth

- The sign-in/OAuth UI was deleted in the desktop pivot; there is no login route. Run with `SELF_HOSTED=1` in `.env.local` — `lib/subscription.ts` then resolves a synthetic single owner and every page authenticates. Drive with claude-in-chrome against the user's Chrome.

## Driving

- `/dashboard/workflows` — create throwaway workflows via the "+" card for destructive tests; never touch the user's real workflows (e.g. "Check email").
- Two-step delete buttons (settings entries, workflows) auto-disarm after 3s — a disarm can fire *between* browser_batch calls and your next click re-arms instead of confirming. Put arm-click + confirm-click in the SAME browser_batch, back to back.
- Card grids reflow after a delete — a second click at the old coordinates lands on the next card. Screenshot before clicking again.

## Gotchas

- No test suite; `npm run lint` + `npx tsc --noEmit` are the only static checks.
- Stripe webhook flows need `stripe listen --forward-to localhost:3000/api/auth/stripe/webhook`.
