---
name: verify
description: How to run and verify Saturn changes end-to-end (the desktop app, its data, driving the dashboard)
---

# Verifying Saturn

Saturn is a native macOS app, not a web page. `npm run dev` is `tauri dev`: it
starts the Next dev server on :3000 **and** the Rust backend, and opens the
window. All four background loops (cron scheduler, Discord gateway, Telegram
poller, GitHub poller) run in it, so scheduled and event-driven workflows are
live in dev.

## Launch

- `npm run dev` from the repo root. Frontend edits hot-reload; a Rust edit
  rebuilds and relaunches the app.
- `tauri-plugin-single-instance` is registered first, deliberately: a second
  `npm run dev` focuses the existing window instead of opening a second process
  against the same `saturn.db`. Kill the first one before starting a second.
- Closing the window only **hides** it — the process keeps running with its
  loops. Quit from the tray icon.
- Rust `println!`/`eprintln!` goes to the terminal running `tauri dev`; the
  transports log there (`[telegram <fp>] …`, `[gateway] …`).
- Frontend console + network: right-click in the window → Inspect Element opens
  WebKit's inspector.

## Checks

- `cd src-tauri && cargo test` — the only test suite (131 tests, including the
  47 golden interpreter fixtures). Run it for any interpreter, runner, events,
  integrations or registry change.
- `npm run lint` — regenerates-and-compares `catalog.json`, then ESLint. Any
  edit to a descriptor in `lib/integrations.ts` needs
  `node scripts/gen-catalog.mjs` or this fails.
- `npx tsc --noEmit` — the frontend's only other static check.

## Data

- One SQLite file, `saturn.db`, in the app's data dir
  (`~/Library/Application Support/com.wilcus.saturn/`). Inspect with
  `sqlite3`; the app holds one connection behind a mutex, so close the app
  before writing to it yourself.
- Secrets are **not** in the database. They live in the login Keychain under
  the `com.wilcus.saturn` service and are write-only through the UI — no read
  path returns one. Check with Keychain Access, or
  `security find-generic-password -s com.wilcus.saturn`.
- No environment variables. Nothing in `app/`, `lib/` or `src-tauri/` reads one.

## Driving the UI

Drive the WebView with claude-in-chrome only against `http://localhost:3000`
in the user's Chrome — the dev server serves the same frontend, but with no
Tauri IPC, so every `call()` fails. That is enough for pure layout work and
nothing else; anything touching data has to be driven by hand in the app window
or asserted through `cargo test`.

- `/dashboard/workflows` — create throwaway workflows via the "+" card for
  destructive tests; never touch the user's real workflows.
- Two-step delete buttons (settings entries, workflows) auto-disarm after 3s.
- Card grids reflow after a delete — a second click at the old coordinates
  lands on the next card.
