//! Inbound-event dispatch: the subscription feed every real-time transport
//! reads, and the validate → claim → execute funnel every delivery goes through.
//! Port of lib/events.server.ts.
//!
//! # The interface, for the three transports
//!
//! ```ignore
//! // -- reconcile loop -------------------------------------------------------
//! // `changed` is created ONCE, before the first read: a receiver only sees
//! // changes published after it was made, so subscribing inside the loop drops
//! // every mutation that lands while a poll is in flight.
//! let mut changed = events::on_subscriptions_changed();
//! loop {
//!     let subs = tauri::async_runtime::spawn_blocking({
//!         let store = store.clone();
//!         move || events::get_event_subscriptions(&store, &secrets::KEYCHAIN)
//!     }).await.unwrap();
//!     match subs {
//!         // KEEP the current connection set on a read failure. `Ok(vec![])`
//!         // means "disconnect everything"; a transient DB error must not.
//!         Err(err) => eprintln!("[telegram] subscription read failed: {err}"),
//!         Ok(subs) => reconcile(subs.into_iter().filter(|s| s.provider == "telegram")),
//!     }
//!     tokio::select! {
//!         _ = tokio::time::sleep(POLL_INTERVAL) => {}                  // 60s backstop
//!         _ = changed.changed() => tokio::time::sleep(DEBOUNCE).await, // ~2s
//!     }
//! }
//!
//! // -- one delivery ---------------------------------------------------------
//! // ingest_event runs the workflow INLINE and blocks for the whole run, so it
//! // never belongs on the socket path or on a runtime worker.
//! tauri::async_runtime::spawn_blocking(move || {
//!     events::ingest_event(Some(&app), &store, &secrets::KEYCHAIN, &wf_id, &node_id, &payload)
//! });
//! ```
//!
//! Both `get_event_subscriptions` and `ingest_event` are **blocking** (SQLite,
//! the Keychain, and for ingest the entire run). `spawn_blocking`, always.
//!
//! # Rules that are load-bearing here
//!
//! - **`EventSubscription::bot_token` is plaintext.** This module is one of only
//!   two places a `{{var:<uuid>}}` sentinel becomes a real secret (the other is
//!   `integrations::execute`), because this is where the token is consumed: a
//!   transport cannot dial with a sentinel. That plaintext must never reach a log
//!   line, an error string or the database — print `events::fp(token)` instead,
//!   which is why `EventSubscription`'s `Debug` fingerprints it and why it is
//!   deliberately not `Serialize`.
//! - **Every workflow and variable mutation must call `subscriptions_changed()`**
//!   — it drops the cached feed and wakes every transport. Without it a saved bot
//!   token is invisible for up to 60s and a deleted event node keeps delivering.
//! - `provider` is the routing key (`"discord" | "telegram" | "github"`);
//!   `bot_token` is the connection-grouping key. Webhook events have no transport
//!   (a desktop app has no public URL) and never appear in the feed.

use std::collections::HashMap;
use std::fmt;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::AppHandle;
use tokio::sync::watch;

use crate::agent;
use crate::interpreter::{js, Graph, Node, CATALOG};
use crate::registry;
use crate::runner;
use crate::secrets::Vault;
use crate::store::{RunTrigger, Store};

/// Cap on the *workflows* the feed scans (the TypeScript's `limit 500` sat on
/// the workflow query, not on the subscription count — a workflow with three
/// event nodes still counted once). Ported as-is, name included.
const MAX_SUBSCRIPTIONS: usize = 500;
const MAX_NODE_ID: usize = 128;
/// Cap on the payload JSON string a transport hands to `ingest_event`, in UTF-16
/// units — every transport should truncate to this before dispatching.
pub const MAX_EVENT_PAYLOAD: usize = 16_384;
/// TTL of the memoized feed. Matches the transports' reconcile interval, so the
/// second and third caller in a window reuse the first's scan.
const CACHE_TTL: Duration = Duration::from_secs(60);

/// **Zero on purpose.** `store::claim_workflow`'s guard window is what makes a
/// duplicate cron tick a no-op; the event path wants only the other half of that
/// claim — the atomic re-check of `active` plus the `last_run_at` stamp. Every
/// delivered message runs, with no cooldown (lib/events.server.ts:217 has no
/// time predicate at all), because two Discord mentions a second apart are two
/// separate things a user is waiting on. Giving this the cron path's 50s would
/// silently swallow the second one and look exactly like ordinary guard
/// suppression. The stamp still lands, so an event and a cron tick on the same
/// workflow cannot both fire — they share one ledger column.
const EVENT_CLAIM_GUARD_S: i64 = 0;

/// Value-node types whose `config.value` a subscription can resolve without
/// running the graph (`STATIC_VALUE_TYPES`, lib/workflow.ts).
pub(crate) const STATIC_VALUE_TYPES: [&str; 3] = ["string", "number", "literal"];

/// The transport-facing half of an event node's descriptor. The config *field
/// ids* are not repeated here — they come from `catalog.json`, which is
/// generated from the same TypeScript descriptors and therefore cannot drift.
/// Only `platform` and `required` live here (catalog.json carries neither), and
/// `events_match_the_catalog` pins them against it.
struct EventDescriptor {
    node_type: &'static str,
    platform: &'static str,
    required: &'static [&'static str],
}

const EVENTS: &[EventDescriptor] = &[
    EventDescriptor {
        node_type: "event:discord-mentioned",
        platform: "discord",
        required: &["botToken"],
    },
    EventDescriptor {
        node_type: "event:telegram-message",
        platform: "telegram",
        required: &["botToken"],
    },
    EventDescriptor { node_type: "event:github-push", platform: "github", required: &["repo"] },
    EventDescriptor { node_type: "event:github-issue", platform: "github", required: &["repo"] },
    EventDescriptor { node_type: "event:github-pr", platform: "github", required: &["repo"] },
    EventDescriptor { node_type: "event:github-release", platform: "github", required: &["repo"] },
    EventDescriptor { node_type: "event:github-star", platform: "github", required: &["repo"] },
    // Kept so `ingest_event` still recognises a webhook node as an event node,
    // exactly as EXTENSION_EVENTS_BY_KEY did. It is filtered out of the feed
    // (see `transport_event`) — there is no ingress for it in a desktop app.
    EventDescriptor { node_type: "event:webhook", platform: "webhook", required: &[] },
];

fn descriptor(node_type: &str) -> Option<&'static EventDescriptor> {
    EVENTS.iter().find(|e| e.node_type == node_type)
}

/// An event node a transport can actually subscribe to. Webhook events are
/// excluded here so their workflows stay off the MAX_SUBSCRIPTIONS budget and
/// out of every poller.
fn transport_event(node_type: &str) -> Option<&'static EventDescriptor> {
    descriptor(node_type).filter(|e| e.platform != "webhook")
}

/// The canned payload a designer test run seeds an event node with, so a
/// payload → extract chain walks realistic data. Every one is produced by the
/// *production* builder its transport dispatches through — there is no second
/// definition of a payload shape anywhere, in Rust or in TypeScript.
///
/// `None` for a node type nothing builds: `event:webhook` (no ingress in a
/// desktop app) and the non-event nodes callers pass in blind.
pub fn sample_payload(node_type: &str) -> Option<String> {
    match node_type {
        "event:discord-mentioned" => Some(crate::gateway::sample_payload()),
        "event:telegram-message" => Some(crate::telegram::sample_payload()),
        other => crate::github::sample_payload(other.strip_prefix("event:")?),
    }
}

/// Last 4 units of a bot token — the only form of it allowed in a log line.
/// Ported from the identical `fp` helper in gateway.server.ts and
/// telegram.server.ts; one copy here so the two transports cannot diverge.
pub fn fp(token: &str) -> String {
    let units: Vec<u16> = token.encode_utf16().collect();
    format!("…{}", String::from_utf16_lossy(&units[units.len().saturating_sub(4)..]))
}

/// One normalized inbound-event subscription: everything a transport needs to
/// hold a connection and route a delivery. Transports filter on `provider` and
/// group connections by `bot_token`; the remaining per-event config (optional
/// filters like `guildId`/`chatId`, and GitHub's `repo`/`branch`) rides in
/// `config`, already trimmed and with blanks dropped.
#[derive(Clone)]
pub struct EventSubscription {
    pub workflow_id: String,
    pub node_id: String,
    /// owning platform id: "discord" | "telegram" | "github"
    pub provider: String,
    /// ExtensionEvent id without the `event:` prefix, e.g. "discord-mentioned"
    pub event: String,
    /// PLAINTEXT, resolved from a `{{var:}}` sentinel when the node was wired to
    /// a variable. Connection-grouping key. Never log it — see `fp`.
    pub bot_token: String,
    /// non-blank trimmed config minus `botToken`
    pub config: HashMap<String, String>,
}

/// Fingerprints the token. A derived `Debug` would put a live bot token into
/// whatever `{:?}` a transport reaches for, and `Serialize` is withheld for the
/// same reason.
impl fmt::Debug for EventSubscription {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EventSubscription")
            .field("workflow_id", &self.workflow_id)
            .field("node_id", &self.node_id)
            .field("provider", &self.provider)
            .field("event", &self.event)
            .field("bot_token", &fp(&self.bot_token))
            .field("config", &self.config)
            .finish()
    }
}

/// What one delivery did. Safe to log whole — it carries no secret.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IngestResult {
    pub ran: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

fn skipped(reason: &str) -> IngestResult {
    IngestResult { ran: false, reason: Some(reason.to_string()), run_id: None }
}

// --- the subscription feed --------------------------------------------------

/// `hasUnresolvedVariable`: does a well-formed `{{var:<uuid>}}` survive in
/// `text`? Asked of `substitute_variables` — the crate's one sentinel scanner —
/// rather than re-implementing the match, because a second copy of a
/// security-relevant pattern is a second copy to keep correct.
fn has_unresolved_variable(text: &str) -> bool {
    let (_, blanked) =
        crate::integrations::substitute_variables(&HashMap::new(), text, &|_| Some(String::new()));
    blanked != text
}

/// An event node's effective config: the stored literal per descriptor field,
/// replaced by a statically-resolved value edge into the field's same-id port
/// (variable node → its `{{var:<uuid>}}` sentinel, string/number/literal node →
/// its `config.value`; any other source is dynamic and resolves to "" — event
/// config is read before any run). A connected edge always wins over the
/// literal, even blank — same precedence as the interpreter's integration merge
/// and the designer's dimmed-field UX.
fn effective_event_config(
    graph: &Graph,
    node: &Node,
    field_ids: &[&str],
) -> HashMap<String, String> {
    let mut config = HashMap::new();
    for field_id in field_ids {
        let mut value = node.config.get(*field_id).map_or("", |v| js::trim(v)).to_string();
        let edge = graph
            .edges
            .iter()
            .find(|e| e.kind == "value" && e.to.node_id == node.id && e.to.port_id == *field_id);
        if let Some(edge) = edge {
            let src = graph.nodes.iter().find(|n| n.id == edge.from.node_id);
            value = match src {
                Some(src) => match agent::variable_id_from_node_type(&src.node_type) {
                    Some(id) => agent::variable_sentinel(id),
                    None if STATIC_VALUE_TYPES.contains(&src.node_type.as_str()) => {
                        src.config.get("value").map_or("", |v| js::trim(v)).to_string()
                    }
                    // dynamic upstream (or a dangling edge) — unresolvable pre-run
                    None => String::new(),
                },
                None => String::new(),
            };
        }
        config.insert((*field_id).to_string(), value);
    }
    config
}

/// Every active workflow's transport-backed event nodes, normalized. `active` is
/// the only gate. Variable sentinels resolve HERE, at the point of consumption,
/// so transports only ever see plaintext tokens and the graph only ever holds
/// sentinels.
fn load_event_subscriptions(
    store: &Store,
    vault: &dyn Vault,
) -> Result<Vec<EventSubscription>, String> {
    let workflows = store.list_workflows().map_err(|e| e.to_string())?;
    let lookup = registry::variable_lookup(store, vault);
    let mut subscriptions = Vec::new();
    let mut scanned = 0usize;

    for wf in workflows {
        if !wf.active {
            continue;
        }
        // One corrupt graph must not blind every transport. The TypeScript
        // iterated `wf.graph.nodes` unguarded, so a malformed jsonb threw and
        // took the whole feed — and therefore every live connection — with it.
        let Ok(graph) = serde_json::from_value::<Graph>(wf.graph) else {
            continue;
        };
        let event_nodes: Vec<(&Node, &EventDescriptor)> = graph
            .nodes
            .iter()
            .filter_map(|n| transport_event(&n.node_type).map(|d| (n, d)))
            .collect();
        if event_nodes.is_empty() {
            continue;
        }
        scanned += 1;
        if scanned > MAX_SUBSCRIPTIONS {
            break;
        }

        for (node, desc) in event_nodes {
            let Some(entry) = CATALOG.get(&node.node_type) else {
                continue;
            };
            let field_ids: Vec<&str> = entry.config.iter().map(|f| f.id.as_str()).collect();
            let config = effective_event_config(&graph, node, &field_ids);
            // one call per node: `variable_lookup` reads SQLite and the Keychain
            // locally, so the TypeScript's per-owner batching (which existed to
            // collapse Postgres round trips) buys nothing here.
            let (resolved, _) = crate::integrations::substitute_variables(&config, "", &lookup);
            let field = |id: &str| resolved.get(id).map_or("", |v| js::trim(v));

            // skip nodes whose required config is blank or still a sentinel (a
            // deleted variable) — no transport can connect without a token
            if desc.required.iter().any(|f| field(f).is_empty() || has_unresolved_variable(field(f)))
            {
                continue;
            }
            // descriptor-driven: botToken is the grouping key, every other
            // non-blank config field is a transport-interpreted filter. An
            // unresolved sentinel in an optional filter stays literal — it
            // matches nothing (restrictive), never broadens delivery.
            let mut filters = HashMap::new();
            for id in &field_ids {
                let value = field(id);
                if !value.is_empty() && *id != "botToken" {
                    filters.insert((*id).to_string(), value.to_string());
                }
            }
            subscriptions.push(EventSubscription {
                workflow_id: wf.id.clone(),
                node_id: node.id.clone(),
                provider: desc.platform.to_string(),
                event: desc.node_type.trim_start_matches("event:").to_string(),
                bot_token: field("botToken").to_string(),
                config: filters,
            });
        }
    }
    Ok(subscriptions)
}

static CACHE: Mutex<Option<(Instant, Vec<EventSubscription>)>> = Mutex::new(None);

/// The whole feed, memoized for `CACHE_TTL`. Three transports each ask for
/// everything and filter by `provider`, so without this the same full scan ran
/// once per transport.
///
/// `Err` means the read failed, NOT that there is nothing to subscribe to — a
/// caller must keep its current connections on `Err` and only tear one down on
/// an `Ok` that no longer lists it.
pub fn get_event_subscriptions(
    store: &Store,
    vault: &dyn Vault,
) -> Result<Vec<EventSubscription>, String> {
    // held across the load on purpose: single-flight, so three transports waking
    // together produce one scan and two cache hits, which is what memoizing the
    // promise did in the TypeScript. Nothing reachable from here re-enters.
    // `into_inner` on a poisoned lock, not `unwrap`: this mutex is held across the
    // graph scan and a Keychain read, and a panic anywhere under it would otherwise
    // poison it permanently — every later call here AND in `subscriptions_changed`
    // would panic, so all three transports would stop reconciling for the life of
    // the process with no user-visible signal. A stale cached feed beats a dead one.
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, subs)) = cache.as_ref() {
        if at.elapsed() < CACHE_TTL {
            return Ok(subs.clone());
        }
    }
    let subs = load_event_subscriptions(store, vault)?;
    *cache = Some((Instant::now(), subs.clone()));
    Ok(subs)
}

/// Push-invalidation seam. `watch`, not `broadcast`: a burst of designer
/// autosaves must collapse into one wake-up (watch coalesces, broadcast queues
/// each one), and a watch receiver can never miss-and-error the way a lagged
/// broadcast receiver does. The counter is the payload only because `watch`
/// needs one; nobody reads it.
static SUBSCRIPTIONS_CHANGED: LazyLock<watch::Sender<u64>> =
    LazyLock::new(|| watch::channel(0).0);

/// A receiver that wakes on every `subscriptions_changed()`. Create it **before**
/// the first subscription read and keep it for the life of the transport — a
/// receiver made after a mutation has already published will not see it.
pub fn on_subscriptions_changed() -> watch::Receiver<u64> {
    SUBSCRIPTIONS_CHANGED.subscribe()
}

/// Drops the cached feed, then wakes every transport. Fire-and-forget, and a
/// no-op when nothing is listening. **Every workflow and variable mutation must
/// call this** — the cached feed and the live connections are both stale until
/// it does.
pub fn subscriptions_changed() {
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
    // send_modify, not send: it notifies even with zero receivers, so a mutation
    // before any transport has started is not an error.
    SUBSCRIPTIONS_CHANGED.send_modify(|n| *n = n.wrapping_add(1));
}

// --- one delivery -----------------------------------------------------------

/// Runs one delivered event: validate shape (a transport builds payloads too —
/// defense in depth), load the workflow, require a known event node, stamp
/// `last_run_at` while atomically re-checking `active`, then execute.
///
/// Blocks for the whole run. `Err` is a rejected input or a failed run *setup*;
/// a run that starts and then fails is `Ok(ran: true)` with the failure on the
/// `workflow_run` row, exactly as a cron run is.
pub fn ingest_event(
    app: Option<&AppHandle>,
    store: &Store,
    vault: &dyn Vault,
    workflow_id: &str,
    node_id: &str,
    payload: &str,
) -> Result<IngestResult, String> {
    if !registry::is_uuid(workflow_id) {
        return Err("invalid workflowId".into());
    }
    if node_id.is_empty() || node_id.encode_utf16().count() > MAX_NODE_ID {
        return Err("invalid nodeId".into());
    }
    // UTF-16 units, because the cap was written against JS `.length`; a
    // byte-length check would reject payloads the TypeScript accepted.
    if payload.encode_utf16().count() > MAX_EVENT_PAYLOAD {
        return Err("invalid payload".into());
    }

    let Some(wf) = store.workflow(workflow_id).map_err(|e| e.to_string())? else {
        return Ok(skipped("not found"));
    };
    if !wf.active {
        return Ok(skipped("inactive"));
    }

    let graph: Graph = serde_json::from_value(wf.graph.clone())
        .map_err(|e| format!("workflow graph is malformed: {e}"))?;
    let is_event_node =
        graph.nodes.iter().any(|n| n.id == node_id && descriptor(&n.node_type).is_some());
    if !is_event_node {
        return Ok(skipped("no such event node"));
    }

    // stamp last_run_at and atomically re-check active. No row ⇒ the workflow was
    // deactivated between the read above and now — drop the event.
    if !store.claim_workflow(workflow_id, EVENT_CLAIM_GUARD_S).map_err(|e| e.to_string())? {
        return Ok(skipped("inactive"));
    }

    // the delivered JSON reaches the graph on the event node's `payload` port —
    // seeded by node id, so a workflow with two event nodes cannot cross-feed
    let run_id = runner::execute_run(
        app,
        store,
        vault,
        &wf,
        RunTrigger::Event,
        Some(vec![node_id.into()]),
        Some(HashMap::from([(node_id.to_string(), payload.to_string())])),
        None,
    )?;
    Ok(IngestResult { ran: true, reason: None, run_id: Some(run_id) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::{self, FakeVault, Secret};
    use serde_json::{json, Value};

    fn temp_store() -> (std::path::PathBuf, Store, FakeVault) {
        let dir = std::env::temp_dir().join(format!("saturn-events-{}", uuid::Uuid::new_v4()));
        let store = Store::open(&dir.join("saturn.db")).unwrap();
        (dir, store, FakeVault::default())
    }

    fn node(id: &str, node_type: &str, config: Value) -> Value {
        json!({ "id": id, "type": node_type, "x": 0, "y": 0, "config": config })
    }

    fn value_edge(from: &str, from_port: &str, to: &str, to_port: &str) -> Value {
        json!({
            "id": format!("{from}-{to}-{to_port}"),
            "from": { "nodeId": from, "portId": from_port },
            "to": { "nodeId": to, "portId": to_port },
            "kind": "value",
        })
    }

    fn flow_edge(from: &str, to: &str) -> Value {
        json!({
            "id": format!("{from}-{to}-flow"),
            "from": { "nodeId": from, "portId": "out" },
            "to": { "nodeId": to, "portId": "in" },
            "kind": "flow",
        })
    }

    fn deactivate(store: &Store, id: &str) {
        store.conn().execute("update workflow set active = 0 where id = ?1", [id]).unwrap();
    }

    fn subs_by_event(subs: &[EventSubscription], event: &str) -> Vec<EventSubscription> {
        subs.iter().filter(|s| s.event == event).cloned().collect()
    }

    /// The descriptor table carries the two things catalog.json does not
    /// (platform, requiredConfig). Everything else — the config field ids — comes
    /// from the catalog, and this pins the join: an event added to
    /// lib/integrations.ts and regenerated into catalog.json shows up here as a
    /// failure instead of as a node no transport ever subscribes to.
    #[test]
    fn events_match_the_catalog() {
        for desc in EVENTS {
            let entry = CATALOG
                .get(desc.node_type)
                .unwrap_or_else(|| panic!("{} is not in catalog.json", desc.node_type));
            assert_eq!(entry.category, "events", "{}", desc.node_type);
            for required in desc.required {
                assert!(
                    entry.config.iter().any(|f| f.id == *required),
                    "{} has no config field {required}",
                    desc.node_type,
                );
            }
        }
        for key in CATALOG.keys().filter(|k| k.starts_with("event:")) {
            assert!(descriptor(key).is_some(), "{key} is in catalog.json but not in EVENTS");
        }
    }

    /// Every event node a user can drop on the canvas can seed a test run, and
    /// what it seeds is real builder output: a JSON object in the builder's key
    /// order (re-stringifying moves nothing) and inside the ingest cap. Ships an
    /// event type without a sample and this fails instead of the designer
    /// quietly handing that node "".
    #[test]
    fn every_catalog_event_has_a_builder_made_sample() {
        for key in CATALOG.keys().filter(|k| k.starts_with("event:")) {
            let Some(sample) = sample_payload(key) else {
                // the one exception: no ingress means no builder to make one
                assert_eq!(key, "event:webhook", "{key} has no sample payload");
                continue;
            };
            let parsed = js::parse(&sample).unwrap_or_else(|e| panic!("{key}: {e}"));
            let js::J::O(fields) = &parsed else { panic!("{key}: sample is not a JSON object") };
            assert!(!fields.is_empty(), "{key}: empty sample");
            assert_eq!(js::stringify(&parsed), sample, "{key}: not in builder key order");
            assert!(
                sample.encode_utf16().count() <= MAX_EVENT_PAYLOAD,
                "{key}: sample is over MAX_EVENT_PAYLOAD",
            );
        }
        // a non-event node id must not panic — `execute_run` asks blind
        assert_eq!(sample_payload("print"), None);
        assert_eq!(sample_payload("event:nope"), None);
    }

    /// The feed itself: what each transport gets, and everything deliberately
    /// withheld from it.
    #[test]
    fn the_feed_normalizes_every_event_node() {
        let (dir, store, vault) = temp_store();

        // a literal bot token, one blank optional filter and one set one
        let discord = store
            .create_workflow(
                "discord",
                json!({
                    "nodes": [node("d", "event:discord-mentioned", json!({
                        "botToken": " literal-token ", "guildId": "", "channelId": "222",
                    }))],
                    "edges": [],
                }),
            )
            .unwrap();

        // the point of the whole module: the graph holds a sentinel, the vault
        // holds the plaintext, and only the subscription carries the real token
        let variable_id = registry::save_variable(
            &store,
            &vault,
            None,
            "tg token",
            "1:secret-token",
            false,
            true,
        )
        .unwrap();
        assert!(secrets::has(&vault, &Secret::Variable(&variable_id)));
        let telegram = store
            .create_workflow(
                "telegram",
                json!({
                    "nodes": [
                        node("v", &format!("variable:{variable_id}"), json!({})),
                        // the literal loses to the edge, even though it is set
                        node("t", "event:telegram-message", json!({ "botToken": "stale" })),
                    ],
                    "edges": [value_edge("v", "value", "t", "botToken")],
                }),
            )
            .unwrap();

        // github: no bot token at all, and `repo` rides in config for the poller
        let github = store
            .create_workflow(
                "github",
                json!({
                    "nodes": [node("g", "event:github-push", json!({
                        "repo": "octocat/hello-world", "branch": "main",
                    }))],
                    "edges": [],
                }),
            )
            .unwrap();

        // a string node feeding the token resolves statically
        store
            .create_workflow(
                "static",
                json!({
                    "nodes": [
                        node("s", "string", json!({ "value": " from-a-string-node " })),
                        node("d2", "event:discord-mentioned", json!({})),
                    ],
                    "edges": [value_edge("s", "value", "d2", "botToken")],
                }),
            )
            .unwrap();

        // every one of these must produce NOTHING
        store
            .create_workflow(
                "webhook has no transport",
                json!({ "nodes": [node("w", "event:webhook", json!({}))], "edges": [] }),
            )
            .unwrap();
        store
            .create_workflow(
                "blank required config",
                json!({
                    "nodes": [node("b", "event:discord-mentioned", json!({ "botToken": "  " }))],
                    "edges": [],
                }),
            )
            .unwrap();
        store
            .create_workflow(
                "deleted variable",
                json!({
                    "nodes": [
                        node("v", "variable:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", json!({})),
                        node("d", "event:discord-mentioned", json!({})),
                    ],
                    "edges": [value_edge("v", "value", "d", "botToken")],
                }),
            )
            .unwrap();
        store
            .create_workflow(
                "dynamic upstream",
                json!({
                    "nodes": [
                        node("c", "concat", json!({})),
                        node("d", "event:discord-mentioned", json!({ "botToken": "literal" })),
                    ],
                    "edges": [value_edge("c", "out", "d", "botToken")],
                }),
            )
            .unwrap();
        let inactive = store
            .create_workflow(
                "inactive",
                json!({
                    "nodes": [node("d", "event:discord-mentioned", json!({ "botToken": "x" }))],
                    "edges": [],
                }),
            )
            .unwrap();
        deactivate(&store, &inactive.id);
        store.create_workflow("malformed graph", json!({ "nodes": "not an array" })).unwrap();

        let subs = load_event_subscriptions(&store, &vault).unwrap();

        let discord_subs = subs_by_event(&subs, "discord-mentioned");
        assert_eq!(discord_subs.len(), 2, "{subs:#?}");
        let d = discord_subs.iter().find(|s| s.workflow_id == discord.id).unwrap();
        assert_eq!(d.provider, "discord");
        assert_eq!(d.node_id, "d");
        assert_eq!(d.bot_token, "literal-token");
        // botToken never rides in config, blanks are dropped, the rest is trimmed
        assert_eq!(d.config, HashMap::from([("channelId".into(), "222".into())]));
        let s = discord_subs.iter().find(|s| s.workflow_id != discord.id).unwrap();
        assert_eq!(s.bot_token, "from-a-string-node");

        let t = &subs_by_event(&subs, "telegram-message")[0];
        assert_eq!(t.workflow_id, telegram.id);
        assert_eq!(t.provider, "telegram");
        assert_eq!(t.bot_token, "1:secret-token", "the sentinel did not resolve");
        assert!(t.config.is_empty());

        let g = &subs_by_event(&subs, "github-push")[0];
        assert_eq!(g.workflow_id, github.id);
        assert_eq!(g.provider, "github");
        assert_eq!(g.bot_token, "");
        assert_eq!(
            g.config,
            HashMap::from([
                ("repo".into(), "octocat/hello-world".into()),
                ("branch".into(), "main".into()),
            ]),
        );

        assert_eq!(subs.len(), 4, "something unsubscribable produced a subscription: {subs:#?}");
        // and the plaintext is nowhere near a log line
        assert_eq!(fp(&t.bot_token), "…oken");
        assert!(!format!("{t:?}").contains("secret-token"), "Debug leaked the bot token");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The workflow budget. 500 caps scanned *workflows*, so 501 subscribable
    /// ones yield 500 subscriptions.
    #[test]
    fn max_subscriptions_caps_the_scan() {
        let (dir, store, vault) = temp_store();
        let graph = json!({
            "nodes": [node("d", "event:discord-mentioned", json!({ "botToken": "t" }))],
            "edges": [],
        });
        for i in 0..MAX_SUBSCRIPTIONS + 1 {
            store.create_workflow(&format!("wf {i}"), graph.clone()).unwrap();
        }
        assert_eq!(load_event_subscriptions(&store, &vault).unwrap().len(), MAX_SUBSCRIPTIONS);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Every shape check on the ingest path, including the one that must count
    /// UTF-16 units rather than bytes.
    #[test]
    fn ingest_validates_its_input() {
        let (dir, store, vault) = temp_store();
        let id = uuid::Uuid::new_v4().to_string();
        let ingest =
            |wf: &str, node: &str, payload: &str| ingest_event(None, &store, &vault, wf, node, payload);

        assert_eq!(ingest("not-a-uuid", "n", "{}"), Err("invalid workflowId".into()));
        assert_eq!(ingest(&id, "", "{}"), Err("invalid nodeId".into()));
        assert_eq!(ingest(&id, &"n".repeat(MAX_NODE_ID + 1), "{}"), Err("invalid nodeId".into()));
        assert_eq!(ingest(&id, "n", &"p".repeat(MAX_EVENT_PAYLOAD)), Ok(skipped("not found")));
        assert_eq!(
            ingest(&id, "n", &"p".repeat(MAX_EVENT_PAYLOAD + 1)),
            Err("invalid payload".into()),
        );
        // 8k astral chars: 16k UTF-16 units (under the cap) but 32k bytes. A
        // byte-length check would reject this, and a byte-indexed slice would
        // panic on the boundary.
        assert_eq!(ingest(&id, "n", &"😀".repeat(8_000)), Ok(skipped("not found")));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The funnel: what runs, what is refused, and the claim's effect on the
    /// ledger the cron tick shares.
    #[test]
    fn ingest_claims_then_runs() {
        let (dir, store, vault) = temp_store();
        let wf = store
            .create_workflow(
                "mention → print",
                json!({
                    "nodes": [
                        node("d", "event:discord-mentioned", json!({ "botToken": "t" })),
                        node("p", "print", json!({ "message": "ran" })),
                    ],
                    "edges": [flow_edge("d", "p")],
                }),
            )
            .unwrap();
        let runs = || -> i64 {
            store.conn().query_row("select count(*) from workflow_run", [], |r| r.get(0)).unwrap()
        };
        let ingest =
            |node: &str| ingest_event(None, &store, &vault, &wf.id, node, r#"{"content":"hi"}"#);

        // a node that is not an event node is refused before the claim
        assert_eq!(ingest("p"), Ok(skipped("no such event node")));
        assert_eq!(ingest("nope"), Ok(skipped("no such event node")));
        assert_eq!(runs(), 0);
        assert_eq!(
            ingest_event(None, &store, &vault, &uuid::Uuid::new_v4().to_string(), "d", "{}"),
            Ok(skipped("not found")),
        );

        let result = ingest("d").unwrap();
        assert!(result.ran);
        assert_eq!(runs(), 1, "one delivery must start exactly one run");
        let run = store.latest_run(&wf.id).unwrap().unwrap();
        assert_eq!(run.id, result.run_id.unwrap());
        assert_eq!(run.trigger, "event");
        assert_eq!(run.status, "success", "log: {:#}", run.log);

        // the claim stamped the shared ledger, so a cron tick inside its window
        // cannot double-run the same workflow
        assert!(!store.claim_workflow(&wf.id, 50).unwrap());

        // …but a second delivery DOES run. The event claim has no cooldown on
        // purpose (EVENT_CLAIM_GUARD_S) — two mentions are two things the user is
        // waiting on, and cron's 50s window would silently eat the second.
        assert!(ingest("d").unwrap().ran);
        assert_eq!(runs(), 2);

        // deactivation is re-checked atomically as part of the claim
        deactivate(&store, &wf.id);
        assert_eq!(ingest("d"), Ok(skipped("inactive")));
        assert_eq!(runs(), 2);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The whole point of the funnel: what the transport delivered is what the
    /// graph reads off the event node's `payload` port. Was a pinned gap until
    /// `execute_run` gained `event_payloads` (Phase E wiring).
    #[test]
    fn the_event_payload_reaches_the_graph() {
        let (dir, store, vault) = temp_store();
        let wf = store
            .create_workflow(
                "payload → print",
                json!({
                    "nodes": [
                        node("d", "event:discord-mentioned", json!({ "botToken": "t" })),
                        node("p", "print", json!({ "message": "unused" })),
                    ],
                    "edges": [flow_edge("d", "p"), value_edge("d", "payload", "p", "message")],
                }),
            )
            .unwrap();

        ingest_event(None, &store, &vault, &wf.id, "d", r#"{"content":"marker"}"#).unwrap();
        let log = store.latest_run(&wf.id).unwrap().unwrap().log.to_string();
        assert!(log.contains("marker"), "the event payload never reached the graph: {log}");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The invalidation seam — both the explicit call and the one every workflow
    /// write now makes for itself (`store::create_workflow`), which is what stops
    /// a transport listening with a stale token.
    ///
    /// The *cache-hit* half is deliberately not asserted any more: the cache is
    /// process-wide while `Store` is per-test, so any other test's
    /// `create_workflow` invalidates it mid-assertion and the suite runs in
    /// parallel. A missed hit costs one extra scan; a missed invalidation is the
    /// dangerous direction, and that is what is pinned here.
    #[test]
    fn subscriptions_changed_drops_the_cached_feed() {
        let (dir, store, vault) = temp_store();
        let graph = json!({
            "nodes": [node("d", "event:discord-mentioned", json!({ "botToken": "t" }))],
            "edges": [],
        });
        store.create_workflow("first", graph.clone()).unwrap();

        subscriptions_changed(); // start from a known-cold cache
        let changed = on_subscriptions_changed();
        assert_eq!(get_event_subscriptions(&store, &vault).unwrap().len(), 1);

        // a raw insert, deliberately going around `store::create_workflow`: the
        // feed must not see it until something invalidates
        store
            .conn()
            .execute(
                "insert into workflow (id, name, graph, created_at, updated_at)
                 values (?1, 'second', ?2, 0, 0)",
                rusqlite::params![uuid::Uuid::new_v4().to_string(), graph.to_string()],
            )
            .unwrap();
        subscriptions_changed();
        assert_eq!(get_event_subscriptions(&store, &vault).unwrap().len(), 2);
        // …and the ordinary write path invalidates on its own, with no explicit
        // call — the invariant every transport depends on
        store.create_workflow("third", graph).unwrap();
        assert_eq!(get_event_subscriptions(&store, &vault).unwrap().len(), 3);
        // and a transport parked on the watch is awake
        assert!(changed.has_changed().unwrap());

        subscriptions_changed(); // leave it cold for whatever runs next
        std::fs::remove_dir_all(&dir).ok();
    }
}
