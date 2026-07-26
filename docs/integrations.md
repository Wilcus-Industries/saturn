# Integration actions + event transports

> Part of the Saturn docs set indexed in `CLAUDE.md`. Node shapes and the catalog are in `docs/nodes.md`; the run pipeline is in `docs/workflows.md`.

## One descriptor per platform

`lib/integrations.ts` is the client-safe half. Each `PlatformExtension` in
`EXTENSIONS` bundles one app's `app` name and `logoDomain` plus its outbound
`actions` and inbound `events`; the flat views at the bottom
(`INTEGRATIONS`, `INTEGRATIONS_BY_ID`, `EXTENSION_EVENTS`,
`EXTENSION_EVENTS_BY_KEY`) are what every consumer reads.

Adding a platform, action or event is **one descriptor here**, plus:

- for an action — a sender in `src-tauri/src/integrations.rs`;
- for an event — a handler in the matching transport (`gateway.rs`,
  `telegram.rs`, `github.rs`) and a row in `events.rs`'s `EVENTS` table;
- `node scripts/gen-catalog.mjs` to regenerate `catalog.json`.

The designer, toolbox and interpreter need no changes. A provider whose color
category is not yet in `INTEGRATION_SECTIONS` needs that name added too; a new
`app` value just heads a new toolbox subsection.

`lib/integrations.ts` may only `import type` from `lib/workflow.ts` —
`workflow.ts` value-imports this file, so a value import back cycles at runtime.

**The payload shape is not described here.** It is defined once, in Rust, by the
builder its transport dispatches through, and a designer test run seeds event
nodes from those same builders via `events::sample_payload`
(`docs/open-decisions.md` §1.4).

## Action nodes

Orange, toolbox group "Apps", keys `integration:<provider>`. Ordinary rectangles:
flow in, flow out, and **one value input per config field** (same id, with
`overriddenBy` auto-derived) that overrides the field's literal when connected —
so tokens, channel ids and messages are all wireable from upstream nodes. Paired
ports render inline on the config row's left edge rather than as a separate port
row (`pairedInputIds` / `unpairedInputs` in `geometry.ts`).

An action may declare one **value output** (`IntegrationAction.output`); the
interpreter stashes the sender's result under that port, which is what makes
read-style actions possible.

Each descriptor carries two fields that split **grouping** from **color**: `app`
names the app and heads its toolbox subsection; `section` names one of
`INTEGRATION_SECTIONS` (`events`/`logic`/`data`) and supplies only the color, so
a Discord webhook in "data" paints teal like the `print` node. Resolve it through
`entryStyles(entry)` or integrations revert to orange.

| node | does |
|---|---|
| `discord-webhook` | POSTs a pasted webhook URL. The URL is stored plaintext in the graph — the user's own graph, accepted |
| `discord-send-message` | bot API `POST /channels/{id}/messages` |
| `discord-read-messages` | `GET /channels/{id}/messages?limit=N` (1–100, default 20) → compact chronological JSON array on the `messages` output. No Telegram counterpart: the Bot API has no history endpoint |
| `discord-typing` | `POST /channels/{id}/typing`. "off" is a no-op — Discord auto-expires after ~10s and has no cancel call |
| `telegram-send-message` | `sendMessage`, or `sendPhoto` multipart when the message is an image data URL |
| `telegram-typing` | `sendChatAction`. Same auto-expiry (~5s), same no-op "off" |
| `http-request` | any REST call. `method`/`url`/`headers` (JSON object)/`body`; result on `response` is `{status, contentType, body, truncated?}`. **Non-2xx comes back as data, not an error**, so graphs branch on `status` |

Images: a `message` that is a `data:image/…;base64,…` URL (e.g. an agent node's
`output=image` result) is uploaded as an attachment rather than sent as text —
`files[0]` multipart on Discord (8 MiB cap), `sendPhoto` on Telegram (10 MiB).
The 4096-char message cap exempts image data URLs and allows up to
`MAX_INTEGRATION_IMAGE` (4 MiB), mirroring the runner's `MAX_IMAGE_DATA_URL`.

### The SSRF guards

`integrations.rs` is security-critical and translated as-is, not improved. Config
arrives from the graph and is untrusted, so **every value that reaches a URL path
is shape-checked first**. Two guards carry the weight:

- **Exact-host allowlists** (`==`, never `contains`) for the Discord webhook URL
   — the only sender whose URL is user-supplied. https + `discord.com` /
  `discordapp.com` + an `/api/webhooks/` path prefix.
- **Charset checks on ids and tokens**, because a Discord channel id and a
  Telegram bot token are interpolated straight into the request path. Anything
  admitting `/`, `?`, `#` or `%` would let config re-aim the request at another
  endpoint of the same host. Snowflakes are `^\d{17,20}$`; Telegram tokens
  `^\d{1,20}:[A-Za-z0-9_-]{25,64}$`; chat ids numeric or `@username`.

`http.rs` `send` is the template for any future sender fetching an
attacker-influenced URL: `assert_public_https_url` re-validated on **every**
redirect hop through a manual loop (max 5; 301/302/303 downgrade to GET and drop
the body), header names charset-checked and CRLF-rejected, response read capped
at 1 MiB, whole-request deadline.

**`http-request` deliberately does not use the strict guard.** `parse_request_url`
checks the scheme and nothing else — private addresses, plain http and localhost
all pass, because on a single-user desktop the graph is the user's own and the
node's whole point is reaching Ollama on 11434, a NAS, or Home Assistant. The
strict guard *is* still enforced on every MCP fetch, where the URL and all
metadata-derived endpoints are attacker-controlled. `docs/open-decisions.md` §1.3.

Budget: `MAX_INTEGRATION_CALLS = 20` per run.

## Event nodes

Keys `event:<id>`, catalog category `events` — so entry resolution, the one-event
rule and the spawn guard all come free. They render as ordinary rectangles in
amber (they carry **no** `section`, unlike action nodes), with no flow input
(they are entry points), a flow `out`, a `payload` value output carrying the
event as a JSON string, and the same per-config value inputs action nodes have.

| node | required | optional |
|---|---|---|
| `event:discord-mentioned` | `botToken` | `guildId`, `channelId` filters |
| `event:telegram-message` | `botToken` | `chatId` (numeric or `@username`) |
| `event:github-push` | `repo` (`owner/repo`) | `branch` |
| `event:github-issue` / `-pr` / `-release` / `-star` | `repo` | — |
| `event:webhook` | — | no ingress; see below |

**Event config is read statically by `events.rs`, never by the interpreter.** A
value edge into a config port replaces the literal, but only three source kinds
resolve: a variable node (substituted per the sentinel rules), or a
`string`/`number`/`literal` node (`config.value`). Anything dynamic resolves to
blank, and `validate_graph` warns on such an edge. An unresolved sentinel in
a *required* field drops the subscription; in an optional filter it stays literal
and matches nothing.

## The event spine — `events.rs`

Every transport reads the same feed and pushes every delivery through the same
funnel.

```
get_event_subscriptions(store, keychain) -> Vec<EventSubscription>
ingest_event(app, store, keychain, wf_id, node_id, payload) -> IngestResult
```

Subscriptions are normalized to
`{workflow_id, node_id, provider, event, bot_token, config}` for every `active`
workflow's event nodes with non-blank required config. `provider` is the routing
key each transport filters on; `bot_token` is the connection-grouping key.
Webhook events are filtered out of the feed entirely, so their workflows stay off
the `MAX_SUBSCRIPTIONS = 500` budget and out of every poller.

**`bot_token` is plaintext.** This is one of only two places a `{{var:}}` sentinel
becomes a real secret (the other is `integrations::execute`), because a transport
cannot dial with a sentinel. That plaintext must never reach a log line, an error
string or the database — `EventSubscription`'s `Debug` fingerprints it via
`events::fp` and it is deliberately not `Serialize`.

Both functions are **blocking** — SQLite, the Keychain, and for ingest the entire
run. `spawn_blocking`, always. `ingest_event` runs the workflow inline and blocks
for its whole duration, so it never belongs on a socket path or a runtime worker.

The reconcile loop every transport runs is written out in `events.rs`'s header;
copy it rather than reinventing it. Two things it gets right that are easy to get
wrong: the `changed` receiver is created **once, before the first read** (a
receiver only sees changes published after it was made), and a failed
subscription read **keeps** the current connection set — `Ok(vec![])` means
"disconnect everything", a transient DB error must not.

**The claim guard is 0 seconds, not the cron path's 50.** Every mention runs. A
50s window would silently drop the second of two Discord messages a minute
apart, which is exactly what a chat bot must not do. The 0 short-circuits to "no
predicate" rather than `last_run_at <= now`, because the latter dropped
deliveries whenever an NTP step put the clock behind the stamp
(`docs/open-decisions.md` §2.3).

## Discord — `gateway.rs`

One WebSocket per distinct bot token, keyed by the token *value*, so a rotated
token arrives as a new key and gets a fresh socket. This is the only place in the
app that holds a socket open; everything else polls.

On `MESSAGE_CREATE` it skips bot authors (loop guard), matches plain @-mentions
of the connected bot (role and @everyone mentions do not count), applies each
subscription's optional guild/channel filters, and hands one `ingest_event` per
match to the spine.

**Fatal closes must stay fatal.** 4004/4010/4011/4012/4013 mean reconnecting can
never help; retrying them forever is a hammering loop against Discord with a
credential it has already rejected. 4014 (Message Content intent not enabled) is
the one exception and only once — it retries with `GUILD_MESSAGES` alone, because
mention messages carry `content` even without the privileged intent.

The protocol state machine holds **no token at all**: the three frames that carry
one are built by free functions taking it as an argument, so a `{:?}` of the
connection state cannot leak it.

## Telegram — `telegram.rs`

One `getUpdates` long-poll loop per distinct bot token, holding the request open
25s server-side. Async `reqwest` here, not the blocking client used elsewhere: a
poll parks for up to 35s and there is one per token, so blocking calls would hold
a `spawn_blocking` thread each for the life of the app.

Three load-bearing facts:

- **`getUpdates` is single-consumer.** Telegram answers a second concurrent
  consumer of the same token with 409, and the two then steal each other's
  updates. The poller map is keyed by token value and touched only by the single
  reconcile task, so a token can never have two loops — which means a 409 is
  *external* (a webhook is set, or another Saturn is running) and is retried
  slowly rather than "healed" by deleting the webhook.
- **The token rides in the URL path**, so a `reqwest::Error`'s `Display` would
  print it into a log line. Nothing in the module ever formats one.
- **The offset is the ack.** It advances past every update in a batch — including
  ones this poller skips or filters — and stays put on any failed response, which
  is what makes a dropped batch redeliver instead of vanish.

401/404 kill the token until its value changes (mirroring Discord's 4004); 429
honors `retry_after`; backlog older than 5 minutes is skipped, so downtime does
not replay. Bots never receive their own messages through `getUpdates`, so no
loop guard is needed.

## GitHub — `github.rs`, a poller

**This is the biggest divergence from the hosted product.** The central GitHub
App and its HMAC-verified webhook were decommissioned; a desktop app has no
public URL. GitHub events now arrive by polling one endpoint per watched
resource, authenticated with a single fine-grained read-only PAT in the Keychain.

| node | endpoint | cursor |
|---|---|---|
| `github-push` | `/git/refs/heads/{branch}` + the compare API | head SHA |
| `github-issue` | `/issues?sort=created&direction=desc&state=all` | issue number |
| `github-pr` | `/pulls?sort=created&direction=desc&state=all` | PR number |
| `github-release` | `/releases` | release id |
| `github-star` | `/stargazers` (star+json, last page) | `starred_at` |

The deleted poller used `/repos/{o}/{r}/events` and was blamed for lag; its own
comment named the real cause — that endpoint is documented as *not* real-time
(30s–6h, 60s cache). These five read primary data and carry no such caveat, so
latency becomes the poll interval (`POLL_S = 30`).

Three things are load-bearing:

1. **The baseline cursor.** The first poll of a resource records the current max
   and dispatches nothing. Without it, saving a workflow replays the repo's
   entire history the first time it polls.
2. **The error taxonomy.** 401 kills the poller until the PAT changes (a bad
   token never fixes itself); 404/451 retry at 15 min (a renamed repo, or a token
   without access, is fixable outside Saturn); 403/429 sleep to the rate-limit
   reset; everything else backs off exponentially.
3. **Conditional requests.** A 304 costs no rate-limit quota, which is the only
   reason a 30s interval is free. The ETag is stored per resource next to its
   cursor.

Cursors live in their own `github_cursor` table (created by `github.rs`, which
owns it) rather than in memory — a memory-only cursor re-baselines on every
launch, which is the history-replay bug with extra steps.

**What a persisted cursor does not buy is catch-up.** A poll waking to a weekend
of backlog advances past all of it and dispatches only what is younger than
`SKIP_OLDER_THAN_S = 900`. If something happens while the laptop is closed, it
does not fire on wake. The cursor still advances on a skip — skipping means
"acknowledge without dispatching", never "leave for next time". This was a
deliberate call: re-announcing week-old issues to Discord as if they just
happened was judged worse than missing them (`docs/open-decisions.md` §1.1).

**`github-star` requires a PAT.** Page 1 of `/stargazers` is fetched *without*
`if-none-match` on purpose (it holds the oldest stars and would 304 forever), so
it cannot 304, and at a 30s interval one watch is ~120 counted requests/hour
against a 60/hr unauthenticated budget. The rate limit is per-token and
`resume_at` is global, so an unauthenticated star watch parks push, issue, pr and
release too — and since events arriving during a park are discarded, it was not
noisy, it was lossy for everything else. Three layers enforce it:
`Resource::pollable` (the one that matters — a star node already in a saved graph
would otherwise keep polling), the greyed-out toolbox chip, and a
`validate_graph` warning for a node placed before the PAT was removed
(§1.2). The other four resources poll public repos fine unauthenticated.

Push is the one event needing a second call: the refs endpoint carries only a
SHA, so `enrich_push` fetches the compare API for the pusher, commit count and
messages. That is why the push *sample* is the unenriched shape — all keys
present, those four empty.

## `event:webhook` has no ingress

It is still a live catalog key, so `ingest_event` recognises a webhook node as an
event node, but it is filtered out of the subscription feed and nothing builds
its payload — a desktop app has no public URL to POST. A test run hands the node
`""` rather than a sample, because there is no honest sample to produce and
authoring one would be exactly the payload literal §1.4 removed.

## Adding a transport

Copy the reconcile loop from `events.rs`'s header. Then, in order of how easy
each is to get wrong: fingerprint the token in every log line, push
`ingest_event` to `spawn_blocking`, keep the connection set on a failed
subscription read, and decide explicitly which failures are fatal-until-the-
credential-changes versus retryable.
