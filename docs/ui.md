# Routes, shell and the IPC seam

> Part of the Saturn docs set indexed in `CLAUDE.md`. Update both in the same change.

## Routes

Eight pages, all statically exported. `trailingSlash: true`, so every route emits
as `<dir>/index.html` and every internal href must carry the slash — Tauri's
asset protocol does no extensionless fallback.

| route | file | shell | id |
|---|---|---|---|
| `/dashboard/agent/` | `(shell)/agent/page.tsx` | yes | — |
| `/dashboard/sessions/` | `(shell)/sessions/page.tsx` | yes | — |
| `/dashboard/workflows/` | `(shell)/workflows/page.tsx` | yes | — |
| `/dashboard/workflows/runs/?id=` | `(shell)/workflows/runs/page.tsx` | yes | query |
| `/dashboard/workflows/designer/?id=` | `workflows/designer/page.tsx` | **no** | query |
| `/dashboard/memory/` | `(shell)/memory/page.tsx` | yes | — |
| `/dashboard/memory/store/?id=` | `(shell)/memory/store/page.tsx` | yes | query |
| `/dashboard/settings/` | `(shell)/settings/page.tsx` | yes | — |

There is **no `/` and no `/dashboard/` index.** Saturn Agent — the app's front
door, and what the window opens at (`tauri.conf.json` `app.windows[0].url`) —
lives at `/dashboard/agent/`, not `/dashboard/`: `nav.ts:isActive` matches on a
segment boundary, so a base of `/dashboard` would light the Agent tab on every
page in the shell.

Ids ride the **query string**, not a route segment: `output: "export"` prerenders
every route at build time and a segment whose values are user-created uuids
cannot be enumerated. The cost is that every page reading an id calls
`useSearchParams`, which forces a `Suspense` boundary. `docs/open-decisions.md`
§2.6 records the three routes that moved and why an SPA-fallback rewrite was not
an option.

The designer lives **outside** the `(shell)` group on purpose — it takes the full
screen with no top bar. Its ~20 colocated components moved with it when
`workflows/[id]/` was renamed `workflows/designer/`.

## Shell

`(shell)/layout.tsx` is `topBar.tsx` + a `max-w-5xl` content column, stacked:
one 3rem bar across the window — the ascii mark, then a chip per destination —
and `<main>` under it as the only scroller. There is no responsive branch: the
window has a `minWidth` of 768 (`tauri.conf.json`), so the bar is unconditional.
`nav.ts` holds the five destinations and `isActive`, and normalizes trailing
slashes on both sides — `usePathname()` reports what is actually in the address
bar, which is slash-terminated on a hard load but whatever href was pushed after
a client navigation.

**There is no sidebar.** The rail, its collapse preference on
`<html data-sidebar>`, the `<head>` script that stamped it from `localStorage`
before first paint and the `globals.css` rules keyed off it are all gone —
`topBar.tsx` descends from `mobileNav.tsx`, the phone top bar the hosted product
carried and c88d578 deleted, with the width gate removed. The shell now stores
no UI preference at all, so nothing has to survive a reload without a server.

**`<main>` is `overflow-x-hidden`**, which is what lets a page break out of the
content column to the window's full width — the agent page does, so its chat
sidebar can sit against the window's left edge, with
`left-1/2 w-screen -translate-x-1/2`. That is sound only because the bar is
*above* `<main>` rather than beside it, and the part hanging past `<main>`'s
padding box would otherwise be a horizontal scrollbar.

**The agent page's height is a hand-computed calc** —
`h-[calc(100dvh-3rem-2px)]`, being the viewport less the bar's `h-12` and one
border each from the shell's `border-t` and the bar's `border-b`, with `-my-8`
cancelling `<main>`'s `p-8` so the box *consumes* exactly `<main>`'s content
height. That is the price of `<main>` never scrolling; the terms live in
`(shell)/layout.tsx` and `topBar.tsx`, and changing either is what makes it
stale. Growing the calc to "pay for" the negative margin is what hangs the box
past the padding box and puts a scrollbar back.

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
  `run-value` and `run-finished` during a run, `saturn-delta` / `saturn-done`
  during an agent turn, and `data-changed` after background mutations.

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

## Saturn Agent

Two surfaces, one conversation: `/dashboard/agent/` — the window's opening url —
and the `<aside>` docked beside the designer canvas
(`workflows/designer/agentPanel.tsx`, toggled from the canvas control cluster,
width local and never persisted). Both render the same `agentChat.tsx` and drive the same
four session commands, but switch chats differently: the page uses
`agent/sessionSidebar.tsx`, a collapsible column down the window's left edge
(double-click the open chat to rename; collapsed it is a 2.5rem rail of status
glyphs alone, remembered in `localStorage` under `saturnChatRail`), while the
panel keeps the `agent/sessionPicker.tsx` dropdown (`compact`) — a column does
not fit a 300px aside.

**The collapse is one animated width and nothing else.** `w-56` ⇄ `w-10` on
ease-out-quint, with the labels cross-fading against it, over one markup — no
branch on the open state, because two markups pop where one slides. Every
leading cell is the *same* `w-10` as the collapsed rail (`GUTTER` in that file),
which is what holds a status glyph at the identical pixel throughout: the cell
is `shrink-0`, so the aside narrowing around it cannot move it. The curve is
deliberately not an overshoot one — a back-out on `width` dips the rail below
`w-10` and clips the glyphs it exists to show. Both hang `agent/runGlyph.tsx` off every chat they list,
and it has three states: the braille `Spinner` while that session's turn is in
flight (`agentChatStore.ts` `getRunning`), a **green ●** for a reply that landed
while the user was reading a different chat (`getFinished`), and a hollow circle
for idle. One component, because a backgrounded turn keeps streaming and the two
switchers have to say so identically.

The green mark is set by the `saturn-done` listener only when the session is not
the store's current one, and cleared by `setSession` — "until visited" is
literally that. Two consequences worth knowing: it is process state, so a reload
loses it, and the store's `sessionId` stays set while the designer panel holds
that chat, so a turn finishing there reads as already visited.

Either surface can be the first one a session is needed on, so both call
`agent/useEnsureSession.ts` — one hook, because it was a copied effect in both
and the copies shared a bug. It rescues off the **session list** alone and reads
the open chat imperatively: a rescue means "the list changed and no longer holds
the open chat", never "the store switched to something this list has not caught
up with". The second is every freshly created chat — the creator selects it
before the refetch lands — and firing on it is what threw the user back to
`sessions[0]` the instant they pressed `+ new chat`.

`/dashboard/sessions/` is the third surface onto the same rows: the four session
commands again, plus the message count `list_sessions` now returns and a jump
that sets the store's session before navigating. It exists because a chat is no
longer only something you talk in — an `agent` node with a `session` chip wired
writes into one every run (`docs/nodes.md`), and those need somewhere to be read,
renamed and deleted.

**Rust owns the stream.** `saturn_send` returns the moment the turn is spawned
and pushes frames:

| event | payload |
|---|---|
| `saturn-delta` | `{ sessionId, t: "r" \| "c" \| "e" \| "ts" \| "te" \| "g", d }` |
| `saturn-done` | `{ sessionId }` |

`d` is text for `r` (reasoning), `c` (content) and `e` (error), and a JSON string
for the rest: `ts` `{id,name,args}`, `te` `{id,ok,result}`, `g` `{id,graph}`. It
is the hosted NDJSON stream's vocabulary unchanged, which is why the client's
decoder is the same code it was. `saturn-done` is emitted on every path including
failure — nothing else clears `streaming`.

**The conversations live in module state (`agentChatStore.ts`), not React.** The
original reason is gone (a component-owned `fetch` used to die with its mount);
four remain:

- it is the only sink a module-scope Tauri listener can write to — the two
  listeners are registered once for the life of the process and deliberately
  never unlistened, so a turn keeps landing while the chat is unmounted by the
  dashboard ⇄ designer navigation;
- it holds the handoff one-shot (`requestHandoff` / `takeHandoff`) that carries
  "open in designer →" across that navigation;
- it fans the `g` frame out to whichever canvas is open, which is how a
  `save_graph` repaints the designer live (one undo step — `docs/designer.md`);
- it caches a **slot per visited session** — `{ messages, streaming, draft }` —
  so nothing on screen decides whether a turn keeps rendering.

**The slot map is the whole point.** One `messages`/`streaming` pair for N
sessions is what made a turn look dead the moment the user switched chats: the
deltas stopped matching the visible id, a partial reply is in no database (Rust
appends the assistant row *once*, after the turn — `saturn.rs`), and switching
back left `patchLast` staring at a `user` row it refuses to touch, so every
remaining frame went on the floor until `saturn-done`. Keyed, a backgrounded chat
keeps accumulating, `setSession` clears nothing, and the `draft` field is what
makes unsent composer text survive both a chat switch and the unmount a route
change causes. Frames route to their own session's slot; **having a slot** is now
what stops a `saturn-agent` node run writing into a chat the user never opened.

Two chats therefore stream at once, which is why `saturn_stop` takes a session
id: `saturn::cancel_flag` / `cancel_session` keep one `AtomicBool` per session
(the process-wide flag `TEST_RUN_CANCEL` still is), or either stop button would
end both turns.

Neither surface gates the transcript on a fetch — only on `sessionId`.
`agent/page.tsx`'s loader includes `list_models`, a blocking network command that
re-probes every 30s, and blanking a live chat until that lands was the second
half of the same bug. `models` is therefore `ProviderModels[] | undefined`, and
the "connect a model provider →" line waits for a *resolved* empty list.

A slot is a cache of one session's window, not the record: the record is
`saturn_message` in SQLite and Rust appends to it (`docs/workflows.md`). A reply
in progress lives only in the slot, so quitting the app mid-turn still loses it.

**Compaction is a projection, never a deletion.** Once a session's replayed
window passes `COMPACT_AT` UTF-16 units, `saturn::compact` summarizes everything
before the newest `KEEP_RECENT` turns into one appended `saturn_message` row with
`role = 'summary'`, whose `parts` blob carries `{"upto": <id>}` — the last message
it stands for. No row is ever deleted or rewritten: `window` (what the model gets)
starts at the summary and skips what the watermark covers, while `get_messages`
(what the chat renders) still returns everything. Summaries are cumulative — each
fold re-summarizes the previous one — and the tail always reaches the model
verbatim, which together are what keep a long chat from reading as amnesiac. The
row renders as a `<details>` divider in `agentChat.tsx`, sorted to its watermark
rather than its own id, since it is appended at the end while standing for the
beginning. A failed summarizer call is swallowed: the turn runs uncompacted.

Prefs (`agentModel`, `agentEffort`, `saturnSession`) are `localStorage` read in a
mount effect rather than the `<head>`-script pattern — none of them shifts
layout, and the composer already enters on a delay.

The composer's third chip, the **working directory**, is deliberately not one of
them. It sits at the right end of the same row as the model and effort chips
(`ml-auto` is the whole of that alignment, so it lands under the send button),
and it is stored on the *session* rather than in `localStorage`: it is where
`run_command` starts and the only tree that tool may write to, so it belongs to
the conversation that will act in it, not to the browser profile. `saturn_cwd`
reads it back tilde-abbreviated — never blank, so the chip always says where the
shell will actually land — and the picker is Tauri's `plugin:dialog|open` called
straight through `call()`, no npm package: `@tauri-apps/plugin-dialog` is a
wrapper over that one invoke and `lib/ipc.tsx` already is one. The composer takes
no `sessionId` prop; it reads `getSessionId()` off `agentChatStore` through
`useSyncExternalStore`, which is what makes the chip correct in both of
`AgentChat`'s mount points without threading anything through `agentChat.tsx`.

Underneath it sits the **branch line** — `saturn_branch`, read on the same trip
as `saturn_cwd` and again after a pick. The chip above clips a path to its last
two segments, which is exactly what two worktrees of one repository have in
common, so the branch is what tells the user which tree the shell is pointed at.
It is `""` outside a repository and the line is then absent entirely rather than
shown empty. Nothing watches for an external `git checkout`: the value is read
when the session or the directory changes and not otherwise.

## There is no invalidation bus

23 `revalidatePath` calls did not become 23 event channels. A mutation the user
just made is awaited by its own caller, so **the caller refetches**. The only
changes nobody asked for are background ones — a cron firing, a Discord message
landing — and those emit one app-wide `data-changed` with no payload.

Test runs deliberately do **not** emit it: the designer is already following that
run over `run-log`/`run-finished`, and firing it too would make every open page
refetch twice. Full reasoning in `docs/open-decisions.md` §2.7.

## Settings

One page, four groups: Models, the MCP servers / skills / memory stores /
variables registry (`docs/registry.md`), the GitHub PAT, and the login-item
toggle.

**Models is a grid of provider tiles**, one per row of `provider_status` in the
backend's order — a 56px `rounded-[22%]` squircle holding the provider's mark,
served by `providerLogos.tsx` from `public/provider_logos/`. Those are
same-origin PNGs, so `img-src 'self'` already covers them and the full-colour
brand art survives (unlike `icons.tsx`'s currentColor glyphs, which a theme
recolours). Not connected renders `opacity-40 grayscale` and is
still clickable: the tile is never `disabled`, because the modal behind it is
where you go to *fix* being disconnected. Every modal body ends in `SecretForm`
— required for OpenRouter, optional for a local provider that has been moved off
loopback. A provider with `local: true` (Claude Code, OmniRoute) gets three more
things above it: per-id setup instructions, an **address** field writing
`set_provider_origin` (blank restores the shipped default, and the URL goes
through `http::parse_request_url` in Rust, not a check in the form), and a live
status line with a **re-check** button, which calls `provider_status` with
`refresh: true` — the page's own read would be answered from the 30s probe cache,
which is exactly the stale answer that button exists to escape
(`docs/open-decisions.md` §1.6). The address shown is `provider_status.origin`,
so no default is duplicated in TypeScript.

`providerModal.tsx` uses a native `<dialog>`, **not** `modalShell.tsx`.
ModalShell wraps its children in its own `<form>`, and `SecretForm`
(`settings/secretForm.tsx`) is a `<form>` — nesting is invalid HTML, and
re-implementing the write-only convention to fit ModalShell's `action` would put
the "blank means keep" rule in two places. `<dialog>` gives the backdrop,
Escape-to-close and focus trap with no state at all (§2.10).

`SecretForm` is the shape both Keychain-backed secrets on this page share — a
password field, a clear checkbox that only exists once something is stored, and
a save. **Write-only both ways:** the value never comes back over IPC, so blank
means "keep" and there is nothing to prefill.

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
fallback, `relativeTime` living in `workflowCard.tsx`. None of it is broken; all
of it is code someone will read.
