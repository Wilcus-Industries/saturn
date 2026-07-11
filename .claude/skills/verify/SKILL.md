---
name: verify
description: How to run and verify Saturn changes end-to-end (dev server, auth, driving the dashboard)
---

# Verifying Saturn

## Launch

- The user usually already has `npm run dev` on http://localhost:3000 (starting a second instance errors with "Another next dev server is already running" and falls back to :3002 — check `curl -s -o /dev/null -w "%{http_code}" localhost:3000` first and reuse it; it hot-reloads your edits).
- Server log: `.next/dev/logs/next-development.log` (JSON lines; Browser + Server entries). Check timestamps — errors may predate your change.

## Auth

- Google OAuth only — no headless login path. Drive with claude-in-chrome against the user's Chrome; their localhost session is usually already signed in. If not signed in, ask the user to sign in rather than automating OAuth.

## Driving

- `/dashboard/workflows` — create throwaway workflows via the "+" card for destructive tests; never touch the user's real workflows (e.g. "Check email").
- Two-step delete buttons (settings entries, workflows) auto-disarm after 3s — a disarm can fire *between* browser_batch calls and your next click re-arms instead of confirming. Put arm-click + confirm-click in the SAME browser_batch, back to back.
- Card grids reflow after a delete — a second click at the old coordinates lands on the next card. Screenshot before clicking again.

## Gotchas

- No test suite; `npm run lint` + `npx tsc --noEmit` are the only static checks.
- Stripe webhook flows need `stripe listen --forward-to localhost:3000/api/auth/stripe/webhook`.
