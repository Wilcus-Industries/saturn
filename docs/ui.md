# Routes, shell and the IPC seam

> Part of the Saturn docs set indexed in `CLAUDE.md`. Update both in the same change.

## Routes

Six pages, all statically exported. `trailingSlash: true`, so every route emits
as `<dir>/index.html` and every internal href must carry the slash — Tauri's
asset protocol does no extensionless fallback.

| route | file | shell | id |
|---|---|---|---|
| `/dashboard/workflows/` | `(shell)/workflows/page.tsx` | yes | — |
| `/dashboard/workflows/runs/?id=` | `(shell)/workflows/runs/page.tsx` | yes | query |
| `/dashboard/workflows/designer/?id=` | `workflows/designer/page.tsx` | **no** | query |
| `/dashboard/memory/` | `(shell)/memory/page.tsx` | yes | — |
| `/dashboard/memory/store/?id=` | `(shell)/memory/store/page.tsx` | yes | query |
| `/dashboard/settings/` | `(shell)/settings/page.tsx` | yes | — |

There is **no `/` and no `/dashboard/` index.** The dashboard home was the agent
chat, deleted with it (`docs/open-decisions.md` §3.9). The window opens directly
at `/dashboard/workflows/` (`tauri.conf.json` `app.windows[0].url`).

Ids ride the **query string**, not a route segment: `output: "export"` prerenders
every route at build time and a segment whose values are user-created uuids
cannot be enumerated. The cost is that every page reading an id calls
`useSearchParams`, which forces a `Suspense` boundary. `docs/open-decisions.md`
§2.6 records the three routes that moved and why an SPA-fallback rewrite was not
an option.

The designer lives **outside** the `(shell)` group on purpose — it takes the full
screen with no sidebar. Its ~20 colocated components moved with it when
`workflows/[id]/` was renamed `workflows/designer/`.

## Shell

`(shell)/layout.tsx` is `MobileNav` + `Sidebar` + a `max-w-5xl` content column.
`nav.ts` holds the three destinations and `isActive`, shared by both navs, and
normalizes trailing slashes on both sides — `usePathname()` reports what is
actually in the address bar, which is slash-terminated on a hard load but
whatever href was pushed after a client navigation.

**Sidebar collapse state lives on `<html data-sidebar>`, not in React.** A
`<head>` script in `app/layout.tsx` stamps it from `localStorage` before the
first paint and `globals.css` does the width — the same trick as a dark-mode
flash guard, replacing the cookie the server used to read. `sidebar.tsx` reads
that attribute through `useSyncExternalStore` (a `MutationObserver` on the
attribute) for the toggle's icon and `aria-expanded` only; neither shifts layout,
so the pre-hydration frame is harmless.

Fonts come from `next/font/google`, downloaded at **build** time and emitted into
the export. Nothing is fetched from Google at runtime, which is what lets them
load under `default-src 'self'`.

## The IPC seam — `lib/ipc.tsx`

The one place the React app talks to Rust. Everything that used to be a server
action, a server component's `db.query`, or a `fetch` to `app/api/` comes through
here. Two shapes, because the backend speaks in exactly two:

- **`call<T>(cmd, args)`** — request/response over Tauri IPC. Every Rust command
  returns `Result<T, String>` and Tauri rejects with the raw string, which is not
  an `Error` and loses its message through most of React's error paths, so this
  normalizes once. `callVoid` is the fire-and-forget variant for paths that
  genuinely cannot await (unmount flushes).
- **`onEvent(name, fn)`** — Rust pushing without being asked. Carries `run-log`,
  `run-value` and `run-finished` during a run, and `data-changed` after
  background mutations.

**`useAsync(load, opts)`** replaces a server component's `await db.query(...)`.
Pass a stable `load` (it is the dependency). Four behaviours worth knowing:

- `loading` is true only until the **first** load resolves — a background refetch
  keeps stale rows on screen rather than flashing the skeleton again.
- A sequence guard drops a slow first request that resolves after a fast second
  one. That race is a client-fetch problem a server component could not have.
- A failed refetch keeps the last good `data`. A transient error must not blank a
  page that was rendering fine.
- It subscribes to `data-changed` unless `opts.live === false`. The designer
  passes `false`: a background cron run firing `data-changed` would hand it a
  fresh `userCatalog` array mid-edit and break every memoized `Node` for nothing.

`Loading` and `ErrorNote` are the shared placeholders — deliberately plain text,
because every page here is monospace rows on a dark ground and a skeleton that
doesn't match its content reads worse than one line admitting what it's doing.

## There is no invalidation bus

23 `revalidatePath` calls did not become 23 event channels. A mutation the user
just made is awaited by its own caller, so **the caller refetches**. The only
changes nobody asked for are background ones — a cron firing, a Discord message
landing — and those emit one app-wide `data-changed` with no payload.

Test runs deliberately do **not** emit it: the designer is already following that
run over `run-log`/`run-finished`, and firing it too would make every open page
refetch twice. Full reasoning in `docs/open-decisions.md` §2.7.

## Settings

One page, three groups: the two Keychain-backed secrets (OpenRouter key, GitHub
PAT), the MCP servers / skills / memory stores / variables registry
(`docs/registry.md`), and the login-item toggle.

Both secret forms are the same shape twice — a password field, a clear checkbox
that only exists once something is stored, and a save. **Write-only both ways:**
the value never comes back over IPC, so blank means "keep" and there is nothing
to prefill.

The login item writes a LaunchAgent plist naming *the path of the binary that
registered it*, so enabling it from `tauri dev` pins a `target/debug` build that
the next `cargo clean` deletes. The copy says to move the app to `/Applications`
first; nothing enforces it, because a debug build living there is a legitimate
thing to run (`docs/open-decisions.md` §3.11).

## Window lifetime

Closing the window **hides** it (`on_window_event` → `prevent_close()` +
`hide()`). The four background loops belong to the process, not the window;
closing must not stop the scheduler, drop the Discord socket, or strand a poller
mid-cursor. Every way back — the tray's Open item, a second launch, a dock click
— routes through `show_main()`, which calls `show()` *then* `set_focus()`; either
alone only works by accident. Tray → Quit is the only path that terminates the
process.

The tray icon is a macOS **template image** (`icons/tray.png`, black plus alpha)
so AppKit can invert it for a dark menu bar. It is a separate drawing from the
app icon, and its canvas is 44×32 rather than square — `tray-icon` scales to 18pt
of *height* and preserves aspect, so a square canvas would leave Saturn's 2:1
silhouette ~9pt tall. `docs/open-decisions.md` §3.12 has the rest, including why
the SVG must be rasterized with Chrome and not ImageMagick.

## Duplication left over from the parallel build

`docs/open-decisions.md` §3.10 tracks what the four concurrent UI lanes solved
separately — a third modal of the same shape, ten copies of a dead error
fallback, `relativeTime` living in `workflowCard.tsx`, callerless `FormData`
scaffolding. None of it is broken; all of it is code someone will read.
