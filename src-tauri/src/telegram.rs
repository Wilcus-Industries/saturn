//! The Telegram Bot API long-poller. Port of lib/telegram.server.ts.
//!
//! One `getUpdates` loop per distinct bot token, holding the request open for
//! `LONG_POLL_S` server-side, handing every delivered message to
//! `events::ingest_event`. The subscription set is re-read from the spine every
//! `POLL_INTERVAL` and immediately (debounced) on `subscriptions_changed()`.
//!
//! Three things here are load-bearing:
//!
//! - **`getUpdates` is single-consumer.** Telegram answers a second concurrent
//!   consumer of the same token with 409, and the two then steal each other's
//!   updates. The poller map is keyed by token value and is touched only by the
//!   single reconcile task, so a token can never have two loops; a 409 is
//!   therefore *external* (a webhook is set, or another Saturn instance is
//!   running) and is retried slowly rather than healed by deleting the webhook.
//! - **The token rides in the URL path** (`api.telegram.org/bot<token>/…`), so a
//!   `reqwest::Error`'s Display would print it straight into a log line. Nothing
//!   in this module ever formats a `reqwest::Error`; the token appears only as
//!   `events::fp(token)`.
//! - **The offset is the ack.** It advances past every update in a batch —
//!   including ones this poller skips or filters — and stays put on any failed
//!   response, which is what makes a dropped batch redeliver instead of vanish.
//!
//! Async reqwest, not the blocking client used elsewhere in this crate: a poll
//! parks for up to 35 s and there is one per bot token, so blocking calls would
//! hold a `spawn_blocking` thread each for the life of the app. `ingest_event`
//! *is* blocking (it runs the whole workflow inline) and is therefore always
//! handed to `spawn_blocking`, off both the socket path and the runtime workers.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::events::{self, EventSubscription, MAX_EVENT_PAYLOAD};
use crate::integrations::{is_telegram_token, telegram_url};
use crate::interpreter::utf16_prefix;
use crate::secrets::KEYCHAIN;
use crate::store::Store;

/// Reconciliation backstop. Mutations wake the loop immediately via
/// `subscriptions_changed()`; this only bounds how stale the set can get if a
/// notification is ever missed.
const POLL_INTERVAL: Duration = Duration::from_secs(60);
/// Designer autosave fires a mutation per edit; without the debounce a burst
/// would re-read the feed (SQLite + Keychain) once per save.
const REFRESH_DEBOUNCE: Duration = Duration::from_secs(2);
/// Server-side hold. Telegram returns as soon as an update exists, so this costs
/// no latency and amounts to one request per 25 s of silence.
const LONG_POLL_S: u64 = 25;
/// Client-side safety net at `LONG_POLL_S + 10s`: it must never fire before the
/// server's own hold expires, or every quiet poll would look like a timeout and
/// drive the backoff ladder. The 10 s of slack covers request latency.
const FETCH_TIMEOUT: Duration = Duration::from_secs(LONG_POLL_S + 10);
const INITIAL_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// Ignore backlog older than 5 minutes. Telegram holds undelivered updates for
/// 24 h, so without this a first-ever start — or a laptop waking from sleep —
/// replays an hour of chatter as live messages, running the workflow once per
/// message. Losing the backlog of a restart is the cheaper failure.
const SKIP_OLDER_THAN_S: i64 = 300;
/// `event.text` is re-cut to this when the assembled payload would exceed
/// `MAX_EVENT_PAYLOAD`. Unreachable with Telegram's 4096-char message cap, but
/// the ingest shape check must never be tripped by our own payload.
const PAYLOAD_TEXT_CLAMP: usize = 8_000;

fn now_s() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

// --- the update shapes ------------------------------------------------------

#[derive(Deserialize, Debug, Clone)]
struct Chat {
    id: i64,
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    username: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
struct User {
    id: i64,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    first_name: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
struct Message {
    message_id: i64,
    /// unix seconds
    date: i64,
    chat: Chat,
    #[serde(default)]
    from: Option<User>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    caption: Option<String>,
}

#[derive(Debug, Clone)]
struct Update {
    update_id: i64,
    /// `None` for every update kind that is not a plain message —
    /// `edited_message`, `channel_post`, … — and also for a `message` this build
    /// cannot parse.
    message: Option<Message>,
}

/// Deliberately lenient, because JS was lenient by accident: `JSON.parse`
/// accepted any shape and `update.message` was simply `undefined` when the
/// fields did not match. A strict `Vec<Update>` deserialize would fail the whole
/// batch on one unexpected message and — since the cursor only advances on a
/// delivered batch — that batch would redeliver forever, wedging the poller.
/// An unparseable message is dropped; its update_id still acks.
fn parse_update(v: &Value) -> Option<Update> {
    let update_id = v.get("update_id")?.as_i64()?;
    let message = v.get("message").and_then(|m| serde_json::from_value::<Message>(m.clone()).ok());
    Some(Update { update_id, message })
}

/// The payload handed to `ingest_event`. Field order is the serialization order
/// and must mirror the `telegram-message` samplePayload in lib/integrations.ts —
/// it seeds designer test runs and the extract node's path picker.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EventPayload {
    text: String,
    chat_id: String,
    chat_type: String,
    user_id: String,
    username: String,
    first_name: String,
    message_id: String,
    date: String,
}

/// `new Date(secs * 1000).toISOString()` — seconds only, so the fractional part
/// is always `.000`.
fn iso(secs: i64) -> String {
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (y, mo, d) = crate::runner::civil_from_days(days);
    let (h, mi, s) = (rest / 3600, rest / 60 % 60, rest % 60);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.000Z")
}

fn event_payload(m: &Message) -> String {
    let mut event = EventPayload {
        text: m.text.clone().or_else(|| m.caption.clone()).unwrap_or_default(),
        chat_id: m.chat.id.to_string(),
        chat_type: m.chat.kind.clone().unwrap_or_default(),
        user_id: m.from.as_ref().map(|u| u.id.to_string()).unwrap_or_default(),
        username: m.from.as_ref().and_then(|u| u.username.clone()).unwrap_or_default(),
        first_name: m.from.as_ref().and_then(|u| u.first_name.clone()).unwrap_or_default(),
        message_id: m.message_id.to_string(),
        date: iso(m.date),
    };
    let mut payload = serde_json::to_string(&event).unwrap_or_default();
    if payload.encode_utf16().count() > MAX_EVENT_PAYLOAD {
        if let Some(cut) = utf16_prefix(&event.text, PAYLOAD_TEXT_CLAMP) {
            event.text = cut;
        }
        payload = serde_json::to_string(&event).unwrap_or_default();
    }
    payload
}

/// The node's optional `chatId` filter: a numeric id or an `@channelusername`.
fn matches_chat(config: &HashMap<String, String>, m: &Message) -> bool {
    let Some(want) = config.get("chatId").filter(|v| !v.is_empty()) else {
        return true;
    };
    let handle = m.chat.username.as_ref().map(|u| format!("@{u}")).unwrap_or_default();
    *want == m.chat.id.to_string() || *want == handle
}

// --- the response ladder ----------------------------------------------------

/// One classified `getUpdates` response. Splitting this out keeps the whole
/// error taxonomy testable without a socket.
#[derive(Debug)]
enum Poll {
    /// 401/404 — a bad token. Permanent for this token *value*.
    Dead,
    /// 409 — a webhook is set, or another getUpdates consumer holds this token.
    Conflict,
    /// 429. `Some` is the server's `retry_after`, capped; `None` falls back to
    /// the ladder.
    RateLimited(Option<Duration>),
    Failed { status: u16, body: String },
    Updates(Vec<Update>),
}

fn classify(status: u16, body: &str) -> Poll {
    if status == 401 || status == 404 {
        return Poll::Dead;
    }
    if status == 409 {
        return Poll::Conflict;
    }
    // a non-JSON body is not an error by itself — the checks below decide
    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    if status == 429 {
        let retry = parsed
            .get("parameters")
            .and_then(|p| p.get("retry_after"))
            .and_then(Value::as_f64)
            .filter(|s| *s > 0.0)
            // capped, so a hostile or fat-fingered retry_after cannot park a
            // poller for a day
            .map(|s| Duration::from_millis((s * 1000.0) as u64).min(MAX_BACKOFF));
        return Poll::RateLimited(retry);
    }
    let ok = (200..300).contains(&status) && parsed.get("ok") == Some(&Value::Bool(true));
    match (ok, parsed.get("result").and_then(Value::as_array)) {
        (true, Some(result)) => Poll::Updates(result.iter().filter_map(parse_update).collect()),
        _ => Poll::Failed {
            status,
            body: utf16_prefix(body, 200).unwrap_or_else(|| body.to_string()),
        },
    }
}

/// What the loop does after one response.
#[derive(Debug, PartialEq)]
enum Action {
    /// stop this token's loop for good
    Die,
    Sleep(Duration),
    /// straight back into the long poll — the 25 s hold is the pacing
    Poll,
}

/// One token's live poll state. `subs` is shared with the reconcile task, which
/// swaps its contents in place so a workflow or filter edit does not restart the
/// loop (and therefore does not lose the offset or re-hold the connection).
struct Poller {
    token: String,
    subs: Arc<Mutex<Vec<EventSubscription>>>,
    offset: Option<i64>,
    backoff: Duration,
}

impl Poller {
    fn new(token: String, subs: Arc<Mutex<Vec<EventSubscription>>>) -> Self {
        Poller { token, subs, offset: None, backoff: INITIAL_BACKOFF }
    }

    fn backoff(&mut self) -> Duration {
        let wait = self.backoff;
        self.backoff = (self.backoff * 2).min(MAX_BACKOFF);
        wait
    }

    /// Applies one classified response: advances the cursor, moves the backoff
    /// ladder, and calls `dispatch` once per (message × matching subscription).
    ///
    /// `dispatch` is a parameter so the tests can drive the whole ladder — the
    /// cursor, the backlog guard, the chat filter — with no runtime, no database
    /// and no socket. In production it fire-and-forgets an `ingest_event`.
    fn apply(
        &mut self,
        now_s: i64,
        outcome: Poll,
        dispatch: &mut dyn FnMut(&EventSubscription, &Message),
    ) -> Action {
        match outcome {
            Poll::Dead => {
                eprintln!(
                    "[telegram {}] giving up: authentication failed — check the bot token (from @BotFather)",
                    events::fp(&self.token),
                );
                Action::Die
            }
            Poll::Conflict => {
                eprintln!(
                    "[telegram {}] conflict (409): another getUpdates consumer or a webhook is active for this bot — delete the webhook or stop the other poller",
                    events::fp(&self.token),
                );
                Action::Sleep(MAX_BACKOFF)
            }
            // an explicit retry_after does not consume the ladder, so obeying
            // Telegram's own pacing cannot compound into a minute of silence
            Poll::RateLimited(Some(wait)) => Action::Sleep(wait),
            Poll::RateLimited(None) => Action::Sleep(self.backoff()),
            Poll::Failed { status, body } => {
                eprintln!(
                    "[telegram {}] getUpdates failed ({status}): {body}",
                    events::fp(&self.token),
                );
                Action::Sleep(self.backoff())
            }
            Poll::Updates(updates) => {
                self.backoff = INITIAL_BACKOFF;
                for update in updates {
                    // the ack: unconditional, and before any filtering. An
                    // update this poller ignores must never come back.
                    self.offset = Some(update.update_id + 1);
                    self.handle(now_s, &update, dispatch);
                }
                Action::Poll
            }
        }
    }

    fn handle(
        &self,
        now_s: i64,
        update: &Update,
        dispatch: &mut dyn FnMut(&EventSubscription, &Message),
    ) {
        let Some(m) = update.message.as_ref() else {
            return;
        };
        if now_s - m.date > SKIP_OLDER_THAN_S {
            return;
        }
        // cloned rather than held: dispatch spawns, and the reconcile task must
        // never block behind a delivery to swap the subscription set
        let subs = self.subs.lock().unwrap().clone();
        for sub in &subs {
            if !matches_chat(&sub.config, m) {
                continue;
            }
            dispatch(sub, m);
        }
    }
}

// --- the loops --------------------------------------------------------------

async fn run_poller(
    app: AppHandle,
    store: Store,
    token: String,
    subs: Arc<Mutex<Vec<EventSubscription>>>,
) {
    // The token is interpolated into the URL *path*, so its charset is an SSRF
    // guard, not a nicety: a "/", "?" or "#" in it re-aims the request at
    // another endpoint of api.telegram.org. Same check the sender makes before
    // it builds the same URL. Logged once — the task ends, and because its entry
    // stays in the poller map this token value is never respawned.
    if !is_telegram_token(&token) {
        eprintln!(
            "[telegram {}] bot token must look like 123456:ABC… — not polling",
            events::fp(&token),
        );
        return;
    }
    let client = match reqwest::Client::builder().timeout(FETCH_TIMEOUT).build() {
        Ok(client) => client,
        // no `{e}` anywhere near a reqwest error: its Display carries the
        // request URL, and the token is in that URL's path
        Err(_) => {
            eprintln!("[telegram {}] could not build an HTTP client", events::fp(&token));
            return;
        }
    };
    let url = telegram_url(&token, "getUpdates");
    let mut state = Poller::new(token.clone(), subs);

    loop {
        let mut body = json!({ "timeout": LONG_POLL_S, "allowed_updates": ["message"] });
        if let Some(offset) = state.offset {
            body["offset"] = json!(offset);
        }
        let outcome = match client.post(url.clone()).json(&body).send().await {
            Ok(res) => {
                let status = res.status().as_u16();
                match res.text().await {
                    Ok(text) => classify(status, &text),
                    // a truncated body is a transport failure: back off and let
                    // the unchanged offset redeliver the batch
                    Err(_) => {
                        tokio::time::sleep(state.backoff()).await;
                        continue;
                    }
                }
            }
            // network failure, or the client-side safety net firing. Silent, as
            // the TypeScript was.
            Err(_) => {
                tokio::time::sleep(state.backoff()).await;
                continue;
            }
        };

        let mut dispatch = |sub: &EventSubscription, m: &Message| {
            let (app, store, token) = (app.clone(), store.clone(), token.clone());
            let (workflow_id, node_id) = (sub.workflow_id.clone(), sub.node_id.clone());
            let payload = event_payload(m);
            // fire-and-forget: every message runs, with no cooldown, so the poll
            // loop must never wait on a run that can take minutes
            tauri::async_runtime::spawn(async move {
                let ran = tauri::async_runtime::spawn_blocking({
                    let workflow_id = workflow_id.clone();
                    // ingest_event runs the workflow inline and blocks for its
                    // whole duration — never on the poll path, never on a
                    // runtime worker
                    move || {
                        events::ingest_event(
                            Some(&app),
                            &store,
                            &KEYCHAIN,
                            &workflow_id,
                            &node_id,
                            &payload,
                        )
                    }
                })
                .await;
                match ran {
                    Ok(Ok(result)) => {
                        let line = serde_json::to_string(&result).unwrap_or_default();
                        println!(
                            "[telegram {}] delivered to workflow {workflow_id}: {}",
                            events::fp(&token),
                            utf16_prefix(&line, 200).unwrap_or(line),
                        );
                    }
                    Ok(Err(err)) => eprintln!(
                        "[telegram {}] event dispatch failed for workflow {workflow_id}: {err}",
                        events::fp(&token),
                    ),
                    Err(_) => eprintln!(
                        "[telegram {}] event dispatch panicked for workflow {workflow_id}",
                        events::fp(&token),
                    ),
                }
            });
        };

        match state.apply(now_s(), outcome, &mut dispatch) {
            Action::Die => return,
            Action::Poll => {}
            Action::Sleep(wait) => tokio::time::sleep(wait).await,
        }
    }
}

struct Handle {
    subs: Arc<Mutex<Vec<EventSubscription>>>,
    task: tauri::async_runtime::JoinHandle<()>,
}

/// Diffs the wanted subscription set against the live pollers. Only the single
/// reconcile task calls this, which is what guarantees one loop per token — two
/// would 409 against each other and steal each other's updates.
fn reconcile(
    app: &AppHandle,
    store: &Store,
    pollers: &mut HashMap<String, Handle>,
    subs: Vec<EventSubscription>,
) {
    let mut by_token: HashMap<String, Vec<EventSubscription>> = HashMap::new();
    for sub in subs {
        by_token.entry(sub.bot_token.clone()).or_default().push(sub);
    }

    pollers.retain(|token, handle| match by_token.get(token) {
        // swapped in place, so an edit to a filter or a workflow does not
        // restart the loop and lose its offset
        Some(wanted) => {
            *handle.subs.lock().unwrap() = wanted.clone();
            true
        }
        None => {
            println!("[telegram {}] no subscriptions left, stopping poller", events::fp(token));
            // drops the in-flight request at its suspension point — what
            // destroy()'s AbortController did
            handle.task.abort();
            false
        }
    });

    for (token, list) in by_token {
        // A dead poller (401/404, or a malformed token) leaves its entry here
        // with a finished task, which is exactly how the TypeScript's `dead`
        // flag behaved: never retried until the token *value* changes, at which
        // point it arrives as a new map key and gets a fresh poller.
        if pollers.contains_key(&token) {
            continue;
        }
        println!(
            "[telegram {}] starting poller ({} subscription{})",
            events::fp(&token),
            list.len(),
            if list.len() == 1 { "" } else { "s" },
        );
        let subs = Arc::new(Mutex::new(list));
        let task = tauri::async_runtime::spawn(run_poller(
            app.clone(),
            store.clone(),
            token.clone(),
            subs.clone(),
        ));
        pollers.insert(token, Handle { subs, task });
    }
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // created before the first read: a receiver only sees changes published
        // after it exists, so subscribing inside the loop would drop every
        // mutation that lands while a read is in flight
        let mut changed = events::on_subscriptions_changed();
        println!("[telegram] started (poll every {}s)", POLL_INTERVAL.as_secs());
        let mut pollers: HashMap<String, Handle> = HashMap::new();
        loop {
            let store = app.state::<Store>().inner().clone();
            // SQLite + Keychain: blocking, so never inline on a runtime worker
            let read = tauri::async_runtime::spawn_blocking({
                let store = store.clone();
                move || events::get_event_subscriptions(&store, &KEYCHAIN)
            })
            .await;
            match read {
                Ok(Ok(subs)) => {
                    let mine =
                        subs.into_iter().filter(|s| s.provider == "telegram").collect::<Vec<_>>();
                    reconcile(&app, &store, &mut pollers, mine);
                }
                // transient DB unavailability must not tear down live pollers:
                // an empty Ok means "disconnect everything", an Err means
                // "nothing changed, as far as we know"
                Ok(Err(err)) => eprintln!("[telegram] subscription query failed: {err}"),
                Err(_) => eprintln!("[telegram] subscription query panicked"),
            }
            tokio::select! {
                _ = tokio::time::sleep(POLL_INTERVAL) => {}
                _ = changed.changed() => tokio::time::sleep(REFRESH_DEBOUNCE).await,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "123456:ABCDEFGHIJKLMNOPQRSTUVWXY";

    fn sub(chat_id: &str) -> EventSubscription {
        EventSubscription {
            workflow_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
            node_id: "n1".into(),
            provider: "telegram".into(),
            event: "telegram-message".into(),
            bot_token: TOKEN.into(),
            config: match chat_id {
                "" => HashMap::new(),
                id => HashMap::from([("chatId".to_string(), id.to_string())]),
            },
        }
    }

    fn poller(subs: Vec<EventSubscription>) -> Poller {
        Poller::new(TOKEN.into(), Arc::new(Mutex::new(subs)))
    }

    /// Collects deliveries instead of running workflows.
    fn drive(p: &mut Poller, now_s: i64, outcome: Poll) -> (Action, Vec<String>) {
        let mut seen = Vec::new();
        let action =
            p.apply(now_s, outcome, &mut |_sub, m| seen.push(m.text.clone().unwrap_or_default()));
        (action, seen)
    }

    fn ok_body(updates: &str) -> String {
        format!(r#"{{"ok":true,"result":[{updates}]}}"#)
    }

    fn message(id: i64, date: i64, text: &str) -> String {
        format!(
            r#"{{"update_id":{id},"message":{{"message_id":{id},"date":{date},"chat":{{"id":7,"type":"private"}},"text":"{text}"}}}}"#
        )
    }

    /// The `getUpdates` shapes this will actually be handed. Anything that is
    /// not a plain text message must still parse to *something* — silently
    /// failing the batch would wedge the cursor.
    #[test]
    fn parses_real_getupdates_shapes() {
        let body = ok_body(&[
            // a full supergroup message
            r#"{"update_id":10,"message":{"message_id":1,"date":1700000000,"chat":{"id":-1001234567890,"type":"supergroup","username":"saturnchat"},"from":{"id":42,"username":"ada","first_name":"Ada"},"text":"hi"}}"#,
            // a photo with a caption and no `text`
            r#"{"update_id":11,"message":{"message_id":2,"date":1700000000,"chat":{"id":7,"type":"private"},"caption":"look"}}"#,
            // a sticker: neither text nor caption, and no `from`
            r#"{"update_id":12,"message":{"message_id":3,"date":1700000000,"chat":{"id":7,"type":"private"},"sticker":{"file_id":"x"}}}"#,
            // edited_message — no `message` key at all
            r#"{"update_id":13,"edited_message":{"message_id":1,"date":1700000000,"chat":{"id":7},"text":"fixed"}}"#,
            // channel_post — another kind with no `message`
            r#"{"update_id":14,"channel_post":{"message_id":4,"date":1700000000,"chat":{"id":8,"type":"channel"},"text":"news"}}"#,
            // a `message` this build cannot parse (chat.id as a string). JS
            // carried it half-broken; here it degrades to "no message" and still
            // acks, rather than failing the batch into a redelivery loop.
            r#"{"update_id":15,"message":{"message_id":5,"date":1700000000,"chat":{"id":"seven"},"text":"weird"}}"#,
        ]
        .join(","));
        let Poll::Updates(updates) = classify(200, &body) else {
            panic!("expected updates");
        };
        assert_eq!(updates.len(), 6, "every entry must ack");
        assert_eq!(
            updates.iter().map(|u| u.update_id).collect::<Vec<_>>(),
            vec![10, 11, 12, 13, 14, 15],
        );
        assert_eq!(
            updates.iter().filter(|u| u.message.is_some()).map(|u| u.update_id).collect::<Vec<_>>(),
            vec![10, 11, 12],
        );

        let first = updates[0].message.as_ref().unwrap();
        assert_eq!(first.chat.id, -1_001_234_567_890);
        assert_eq!(first.chat.username.as_deref(), Some("saturnchat"));
        assert_eq!(first.from.as_ref().unwrap().first_name.as_deref(), Some("Ada"));
        // the payload's shape AND key order are the designer's samplePayload
        assert_eq!(
            event_payload(first),
            r#"{"text":"hi","chatId":"-1001234567890","chatType":"supergroup","userId":"42","username":"ada","firstName":"Ada","messageId":"1","date":"2023-11-14T22:13:20.000Z"}"#,
        );
        // caption stands in for text; a missing `from` is "" everywhere
        assert!(event_payload(updates[1].message.as_ref().unwrap()).contains(r#""text":"look""#));
        let sticker = event_payload(updates[2].message.as_ref().unwrap());
        assert!(sticker.starts_with(r#"{"text":"","chatId":"7""#), "{sticker}");
        assert!(sticker.contains(r#""userId":"","username":"","firstName":"""#), "{sticker}");

        // an oversized text is clamped, so ingest's payload cap is never tripped
        let long = Message {
            message_id: 1,
            date: 1_700_000_000,
            chat: Chat { id: 7, kind: None, username: None },
            from: None,
            text: Some("x".repeat(MAX_EVENT_PAYLOAD * 2)),
            caption: None,
        };
        assert!(event_payload(&long).encode_utf16().count() <= MAX_EVENT_PAYLOAD);
    }

    /// The offset is the ack. It must move past every update in a delivered
    /// batch, and must NOT move when the batch never arrived — otherwise a
    /// failed poll drops messages Telegram would have redelivered.
    #[test]
    fn the_offset_cursor_acks_exactly_what_arrived() {
        let mut p = poller(vec![sub("")]);
        assert_eq!(p.offset, None); // the first poll asks for whatever is pending

        let now = now_s();
        let body = ok_body(&format!("{},{}", message(10, now, "one"), message(11, now, "two")));
        let (action, seen) = drive(&mut p, now, classify(200, &body));
        assert_eq!(action, Action::Poll); // straight back into the long poll
        assert_eq!(seen, vec!["one", "two"]);
        assert_eq!(p.offset, Some(12));

        // a failed response leaves the cursor put — the batch redelivers
        for outcome in [
            classify(500, "gateway down"),
            classify(429, r#"{"ok":false,"parameters":{"retry_after":3}}"#),
            classify(409, ""),
            classify(200, r#"{"ok":false,"description":"nope"}"#),
        ] {
            let before = p.offset;
            drive(&mut p, now, outcome);
            assert_eq!(p.offset, before);
        }

        // an update this poller ignores still acks: a stale backlog entry and a
        // non-message update must never come back
        let body = ok_body(&format!(
            "{},{},{}",
            message(12, now - SKIP_OLDER_THAN_S - 1, "stale"),
            r#"{"update_id":13,"edited_message":{"message_id":1,"date":0,"chat":{"id":7}}}"#,
            message(14, now, "fresh"),
        ));
        let (_, seen) = drive(&mut p, now, classify(200, &body));
        assert_eq!(seen, vec!["fresh"], "the 5-minute backlog guard must drop the stale one");
        assert_eq!(p.offset, Some(15));

        // a failing ingest cannot stall the cursor either: dispatch is
        // fire-and-forget, so the ack has already happened by the time a run
        // fails. A lost run, deliberately, over a redelivery loop.
        let mut p2 = poller(vec![sub("")]);
        p2.apply(now, classify(200, &ok_body(&message(15, now, "boom"))), &mut |_, _| {
            /* the ingest this stands for returns Err */
        });
        assert_eq!(p2.offset, Some(16));
    }

    /// The backoff ladder and the error taxonomy, including the 409 a second
    /// consumer of the same token produces.
    #[test]
    fn the_backoff_ladder_and_the_409() {
        let mut p = poller(vec![]);
        // 1s → 2s → 4s, doubling only on the failures that consume the ladder
        assert_eq!(drive(&mut p, 0, classify(500, "boom")).0, Action::Sleep(INITIAL_BACKOFF));
        assert_eq!(drive(&mut p, 0, classify(500, "boom")).0, Action::Sleep(Duration::from_secs(2)));
        assert_eq!(drive(&mut p, 0, classify(502, "")).0, Action::Sleep(Duration::from_secs(4)));
        // a 429 with retry_after obeys the server and does not consume the ladder
        assert_eq!(
            drive(&mut p, 0, classify(429, r#"{"parameters":{"retry_after":3}}"#)).0,
            Action::Sleep(Duration::from_secs(3)),
        );
        assert_eq!(
            drive(&mut p, 0, classify(429, r#"{"parameters":{"retry_after":86400}}"#)).0,
            Action::Sleep(MAX_BACKOFF),
        );
        // one without falls back to the ladder, which is still where it was
        assert_eq!(drive(&mut p, 0, classify(429, "{}")).0, Action::Sleep(Duration::from_secs(8)));
        // 409 is external and healable — slow retry, never a webhook delete
        assert_eq!(drive(&mut p, 0, classify(409, "")).0, Action::Sleep(MAX_BACKOFF));
        // a delivered batch resets the ladder
        drive(&mut p, 0, classify(200, &ok_body("")));
        assert_eq!(drive(&mut p, 0, classify(500, "")).0, Action::Sleep(INITIAL_BACKOFF));
        // and it tops out rather than growing without bound
        for _ in 0..10 {
            drive(&mut p, 0, classify(500, ""));
        }
        assert_eq!(drive(&mut p, 0, classify(500, "")).0, Action::Sleep(MAX_BACKOFF));

        // a bad token kills this token's loop for good
        assert_eq!(drive(&mut p, 0, classify(401, "")).0, Action::Die);
        assert_eq!(drive(&mut p, 0, classify(404, "")).0, Action::Die);
    }

    /// The chat filter is the only routing this transport does.
    #[test]
    fn the_chat_filter_matches_ids_and_handles() {
        let m = Message {
            message_id: 1,
            date: 0,
            chat: Chat { id: -100, kind: None, username: Some("saturnchat".into()) },
            from: None,
            text: Some("hi".into()),
            caption: None,
        };
        assert!(matches_chat(&HashMap::new(), &m)); // no filter → every chat
        assert!(matches_chat(&sub("-100").config, &m));
        assert!(matches_chat(&sub("@saturnchat").config, &m));
        assert!(!matches_chat(&sub("100").config, &m));
        assert!(!matches_chat(&sub("@other").config, &m));
        // a chat with no username must not match a bare "@"
        let anon = Message { chat: Chat { id: 7, kind: None, username: None }, ..m.clone() };
        assert!(!matches_chat(&sub("@").config, &anon));

        // one message fans out to every subscription that matches it
        let now = now_s();
        let mut p = poller(vec![sub(""), sub("7"), sub("@nope")]);
        let (_, seen) = drive(&mut p, now, classify(200, &ok_body(&message(1, now, "yo"))));
        assert_eq!(seen, vec!["yo", "yo"]);
    }

    /// A bot token must never reach a log line whole. `fp` is the only rendering
    /// allowed, and it has to survive the degenerate values a misconfigured
    /// variable can produce.
    #[test]
    fn fingerprints_never_expose_a_token() {
        assert_eq!(events::fp(TOKEN), "…VWXY");
        assert_eq!(events::fp("abc"), "…abc");
        assert_eq!(events::fp(""), "…");
        assert_eq!(events::fp("héllo"), "…éllo");
        // a surrogate pair is 2 UTF-16 units, so the tail is 2 emoji
        assert_eq!(events::fp("tok🙂🙂"), "…🙂🙂");
        assert!(!events::fp(TOKEN).contains("123456"));

        // the shape guard between config and the URL path — the token is
        // interpolated into it, so this is the SSRF check, not a format nicety
        assert!(is_telegram_token(TOKEN));
        for bad in ["", "nope", "123456:short", "123456:AAAAAAAAAAAAAAAAAAAAAAAAA/x"] {
            assert!(!is_telegram_token(bad), "{bad:?} must never be polled");
        }
        assert_eq!(
            telegram_url(TOKEN, "getUpdates").as_str(),
            "https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXY/getUpdates",
        );
    }
}
