//! The Discord Gateway listener. Port of lib/gateway.server.ts.
//!
//! One WebSocket per distinct bot token (several workflows can share a bot;
//! connections are keyed by the token *value*, so a rotated token arrives as a
//! new key and gets a fresh socket). On MESSAGE_CREATE it skips bot authors
//! (loop guard), matches plain @-mentions of the connected bot, applies each
//! subscription's optional guild/channel filters, and hands one `ingest_event`
//! per match to the spine. Every mention runs — no cooldown, so there is no
//! queueing here.
//!
//! This is the only place in the app that holds a socket open; everything else
//! polls. The shape mirrors `runner::start_scheduler`: one self-driving task,
//! blocking work (SQLite, the Keychain, the whole run) pushed to
//! `spawn_blocking` so it never sits on a runtime worker — or, here, on the
//! socket path.
//!
//! # Two things that must survive any edit
//!
//! - **A bot token may only ever appear as `events::fp(token)`.** The protocol
//!   state machine (`Conn`) therefore holds no token at all: the three frames
//!   that carry one are built by free functions taking it as an argument, so a
//!   `{:?}` of the connection state cannot leak it.
//! - **Fatal closes must stay fatal.** 4004/4010/4011/4012/4013 mean
//!   reconnecting can never help; retrying them forever is a hammering loop
//!   against Discord with a credential it has already rejected. 4014 is the one
//!   exception, and only once — see `Close::Fallback`.

use std::collections::HashMap;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::{Message, Utf8Bytes};

use crate::events::{self, EventSubscription, MAX_EVENT_PAYLOAD};
use crate::interpreter::{js, utf16_prefix};
use crate::secrets::KEYCHAIN;
use crate::store::Store;

const POLL_INTERVAL: Duration = Duration::from_secs(60);
const REFRESH_DEBOUNCE: Duration = Duration::from_secs(2);
const GATEWAY_URL: &str = "wss://gateway.discord.gg";
const GATEWAY_QUERY: &str = "/?v=10&encoding=json";
const INTENT_GUILD_MESSAGES: u64 = 1 << 9;
const INTENT_MESSAGE_CONTENT: u64 = 1 << 15; // privileged — see the 4014 fallback
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(60);
/// Close codes where reconnecting can never help (bad token, sharding required,
/// invalid version/intents) — give up on the token until its value changes.
const FATAL_CLOSE_CODES: [u16; 5] = [4004, 4010, 4011, 4012, 4013];
/// Discord's own heartbeat interval, used only when a HELLO somehow arrives
/// without one. The TypeScript multiplied `undefined` here and degenerated into
/// a ~1 ms heartbeat loop; that is a self-DoS, not a behaviour worth porting.
const HEARTBEAT_FALLBACK_MS: u64 = 41_250;
/// What an oversized message's `content` is cut to before re-encoding. Cannot
/// trigger at Discord's own message caps — it exists so a payload can never fail
/// the spine's shape check.
const MAX_CONTENT: usize = 8_000;

// --- wire types -------------------------------------------------------------

#[derive(Deserialize)]
struct Packet {
    op: i64,
    #[serde(default)]
    d: Value,
    #[serde(default)]
    s: Option<i64>,
    #[serde(default)]
    t: Option<String>,
}

#[derive(Deserialize, Debug, PartialEq, Clone)]
struct DiscordUser {
    id: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    bot: bool,
}

#[derive(Deserialize)]
struct ReadyData {
    session_id: String,
    #[serde(default)]
    resume_gateway_url: Option<String>,
    user: DiscordUser,
}

#[derive(Deserialize, Debug, PartialEq, Clone)]
struct MessageData {
    id: String,
    #[serde(default)]
    content: String,
    channel_id: String,
    #[serde(default)]
    guild_id: Option<String>,
    #[serde(default)]
    timestamp: String,
    author: DiscordUser,
    #[serde(default)]
    mentions: Vec<DiscordUser>,
}

// --- frames -----------------------------------------------------------------
//
// The only three payloads carrying the bot token. Free functions, not `Conn`
// methods, so the state machine never has to hold one.

fn identify_frame(token: &str, intents: u64) -> String {
    json!({
        "op": 2,
        "d": {
            "token": token,
            "intents": intents,
            "properties": { "os": "linux", "browser": "saturn", "device": "saturn" },
        },
    })
    .to_string()
}

fn resume_frame(token: &str, session_id: &str, seq: i64) -> String {
    json!({ "op": 6, "d": { "token": token, "session_id": session_id, "seq": seq } }).to_string()
}

fn heartbeat_frame(seq: Option<i64>) -> String {
    json!({ "op": 1, "d": seq }).to_string()
}

// --- the protocol state machine ---------------------------------------------

/// What the socket layer should do with one packet. Deliberately data, not
/// calls: everything below this line is pure and testable without a socket.
#[derive(Debug, PartialEq)]
enum Act {
    /// HELLO: (re)start heartbeating every n ms, first beat jittered per docs.
    Beat(u64),
    Identify,
    Resume,
    Heartbeat,
    /// Kill the socket. The close path drives the reconnect, exactly as
    /// `ws.terminate()` did — there is no second reconnect trigger.
    Terminate,
    Dispatch(Box<MessageData>),
    /// READY, carrying the bot's username for the log line.
    Ready(String),
    Resumed,
}

/// The outcome of a close, and the whole reconnect policy.
#[derive(Debug, PartialEq)]
enum Close {
    Retry(Duration),
    /// 4014 with the privileged intent still on: retry once *without*
    /// MESSAGE_CONTENT. Discord delivers full content on messages that mention
    /// the bot regardless of the intent, so mention workflows keep working for
    /// bots whose owner never enabled it in the developer portal.
    Fallback(Duration),
    /// Never reconnect this token value again.
    Fatal(String),
}

/// Connection state. Holds no secret — see the module header.
#[derive(Debug)]
struct Conn {
    seq: Option<i64>,
    session_id: Option<String>,
    resume_gateway_url: Option<String>,
    bot_user_id: Option<String>,
    awaiting_ack: bool,
    reconnect_delay: Duration,
    intents: u64,
}

impl Default for Conn {
    fn default() -> Self {
        Conn {
            seq: None,
            session_id: None,
            resume_gateway_url: None,
            bot_user_id: None,
            awaiting_ack: false,
            reconnect_delay: Duration::from_secs(1),
            intents: INTENT_GUILD_MESSAGES | INTENT_MESSAGE_CONTENT,
        }
    }
}

impl Conn {
    fn on_payload(&mut self, pkt: Packet) -> Vec<Act> {
        if let Some(s) = pkt.s {
            self.seq = Some(s);
        }
        match pkt.op {
            // HELLO — heartbeat, then resume if we have session state, else identify
            10 => {
                let interval = pkt.d.get("heartbeat_interval").and_then(Value::as_u64);
                let resuming = self.session_id.is_some() && self.seq.is_some();
                vec![
                    Act::Beat(interval.unwrap_or(HEARTBEAT_FALLBACK_MS)),
                    if resuming { Act::Resume } else { Act::Identify },
                ]
            }
            11 => {
                self.awaiting_ack = false; // HEARTBEAT ACK
                vec![]
            }
            1 => vec![Act::Heartbeat], // server requests an immediate heartbeat
            7 => vec![Act::Terminate], // RECONNECT — close and resume
            // INVALID_SESSION — d=true means resumable; else start over
            9 => {
                if pkt.d != Value::Bool(true) {
                    self.session_id = None;
                    self.seq = None;
                    self.resume_gateway_url = None;
                }
                vec![Act::Terminate]
            }
            0 => self.on_dispatch(pkt.t.as_deref(), pkt.d),
            _ => vec![],
        }
    }

    fn on_dispatch(&mut self, t: Option<&str>, d: Value) -> Vec<Act> {
        match t {
            Some("READY") => {
                let Ok(ready) = serde_json::from_value::<ReadyData>(d) else {
                    return vec![];
                };
                self.session_id = Some(ready.session_id);
                // The resume host is the one part of the dial target that comes
                // out of a *response*, and the very next thing sent to it is the
                // IDENTIFY/RESUME frame carrying the bot token. A `ws://` value
                // would put that token on the wire in clear text, so anything
                // that is not `wss://` falls back to the constant.
                self.resume_gateway_url =
                    ready.resume_gateway_url.filter(|u| u.starts_with("wss://"));
                self.bot_user_id = Some(ready.user.id);
                self.reconnect_delay = Duration::from_secs(1);
                vec![Act::Ready(ready.user.username)]
            }
            Some("RESUMED") => {
                self.reconnect_delay = Duration::from_secs(1);
                vec![Act::Resumed]
            }
            Some("MESSAGE_CREATE") => match serde_json::from_value::<MessageData>(d) {
                Ok(msg) => vec![Act::Dispatch(Box::new(msg))],
                Err(_) => vec![],
            },
            _ => vec![],
        }
    }

    /// One scheduled beat. A beat while the previous one is still unACKed means
    /// a zombie socket — the TCP connection is up but Discord is gone, and only
    /// the missing ACK reveals it. Terminating forces a reconnect-and-resume,
    /// which is the whole reason the ACK is tracked.
    fn beat(&mut self) -> Act {
        if self.awaiting_ack {
            self.awaiting_ack = false;
            return Act::Terminate;
        }
        self.awaiting_ack = true;
        Act::Heartbeat
    }

    fn on_close(&mut self, code: u16) -> Close {
        self.awaiting_ack = false;
        if code == 4014 && self.intents & INTENT_MESSAGE_CONTENT != 0 {
            self.intents = INTENT_GUILD_MESSAGES;
            // a fresh session: the old one was never established
            self.session_id = None;
            self.seq = None;
            self.resume_gateway_url = None;
            return Close::Fallback(self.next_delay());
        }
        if FATAL_CLOSE_CODES.contains(&code) || code == 4014 {
            return Close::Fatal(match code {
                4004 => "authentication failed — check the bot token".to_string(),
                4014 => {
                    "disallowed intents — enable it for this bot at discord.com/developers"
                        .to_string()
                }
                _ => format!("fatal close code {code}"),
            });
        }
        Close::Retry(self.next_delay())
    }

    /// The backoff ladder: 1s doubling to a 60s ceiling, reset to 1s by a READY
    /// or a RESUMED. Without the ceiling a long Discord outage walks the delay
    /// into hours and the bot never comes back on its own.
    fn next_delay(&mut self) -> Duration {
        let delay = self.reconnect_delay;
        self.reconnect_delay = (self.reconnect_delay * 2).min(MAX_RECONNECT_DELAY);
        delay
    }
}

// --- one delivery -----------------------------------------------------------

/// The subscriptions one message goes to. `author.bot` is the loop guard: a bot
/// must never react to a bot, itself included, or two Saturn workflows can ping
/// each other forever. Only a plain user @-mention counts (a reply with the ping
/// toggle on also lands in `mentions`; role and @everyone mentions deliberately
/// do not).
fn matching<'a>(
    subs: &'a [EventSubscription],
    bot_user_id: &str,
    d: &MessageData,
) -> Vec<&'a EventSubscription> {
    if d.author.bot || !d.mentions.iter().any(|u| u.id == bot_user_id) {
        return Vec::new();
    }
    subs.iter()
        .filter(|sub| {
            let matches = |field: &str, actual: Option<&str>| match sub.config.get(field) {
                Some(want) => actual == Some(want.as_str()),
                None => true, // blank filters are dropped by the feed
            };
            matches("guildId", d.guild_id.as_deref())
                && matches("channelId", Some(&d.channel_id))
        })
        .collect()
}

/// The payload the event node's `payload` port receives. This function IS the
/// definition of the `discord-mentioned` payload shape — `sample_payload` runs
/// it over a canned mention to seed designer test runs, so a key renamed here
/// moves the sample with it and no graph can be built against a stale shape.
fn event_payload(d: &MessageData) -> String {
    let encode = |content: &str| {
        js::stringify(&js::J::O(vec![
            ("content".into(), js::J::S(content.to_string())),
            ("authorId".into(), js::J::S(d.author.id.clone())),
            ("authorUsername".into(), js::J::S(d.author.username.clone())),
            ("channelId".into(), js::J::S(d.channel_id.clone())),
            ("guildId".into(), js::J::S(d.guild_id.clone().unwrap_or_default())),
            ("messageId".into(), js::J::S(d.id.clone())),
            ("timestamp".into(), js::J::S(d.timestamp.clone())),
        ]))
    };
    let payload = encode(&d.content);
    // can't happen with Discord's message caps, but never trip the ingest
    // shape check — a rejected payload is a silently dropped mention
    if payload.encode_utf16().count() > MAX_EVENT_PAYLOAD {
        return encode(&utf16_prefix(&d.content, MAX_CONTENT).unwrap_or_else(|| d.content.clone()));
    }
    payload
}

/// The canned mention a designer test run seeds an `event:discord-mentioned`
/// node with (`events::sample_payload`). Deliberately built by the real
/// `event_payload`, never written out as a second literal.
pub fn sample_payload() -> String {
    event_payload(&MessageData {
        id: "444444444444444444".into(),
        content: "hey @saturn, summarize today's thread".into(),
        channel_id: "222222222222222222".into(),
        guild_id: Some("333333333333333333".into()),
        timestamp: "2026-07-18T12:34:56.000Z".into(),
        author: DiscordUser {
            id: "111111111111111111".into(),
            username: "ada".into(),
            bot: false,
        },
        mentions: Vec::new(),
    })
}

/// Hands every matching subscription to the spine. Fire-and-forget on purpose:
/// `ingest_event` runs the whole workflow inline, and blocking the socket path
/// on it would stall every other message this bot receives — including the
/// heartbeat, which would then look like a zombie and reconnect mid-run.
fn deliver(
    app: &AppHandle,
    tag: &str,
    subs: &[EventSubscription],
    bot_user_id: Option<&str>,
    d: &MessageData,
) {
    let Some(bot_user_id) = bot_user_id else {
        return; // no READY yet — we do not know who we are
    };
    for sub in matching(subs, bot_user_id, d) {
        let payload = event_payload(d);
        let store = app.state::<Store>().inner().clone();
        let (app, tag) = (app.clone(), tag.to_string());
        let (workflow_id, node_id) = (sub.workflow_id.clone(), sub.node_id.clone());
        tauri::async_runtime::spawn_blocking(move || {
            match events::ingest_event(
                Some(&app),
                &store,
                &KEYCHAIN,
                &workflow_id,
                &node_id,
                &payload,
            ) {
                Ok(result) => {
                    let json = serde_json::to_string(&result).unwrap_or_default();
                    let json = utf16_prefix(&json, 200).unwrap_or(json);
                    println!("[gateway {tag}] delivered to workflow {workflow_id}: {json}");
                }
                Err(err) => eprintln!(
                    "[gateway {tag}] event dispatch failed for workflow {workflow_id}: {err}",
                ),
            }
        });
    }
}

// --- the socket -------------------------------------------------------------

/// Why one socket ended.
enum Outcome {
    /// A close code (1006 for anything that died without one), fed to
    /// `Conn::on_close`.
    Closed(u16),
    /// The token left the subscriptions — stop for good.
    Shutdown,
}

/// Uniform in [0, 1). The first heartbeat is jittered by it per Discord's docs,
/// so a process holding several bot connections does not beat them in lockstep.
fn jitter() -> f64 {
    let mut bytes = [0u8; 8];
    if getrandom::fill(&mut bytes).is_err() {
        return 0.5; // a missing RNG must not cost us the connection
    }
    (u64::from_le_bytes(bytes) >> 11) as f64 / (1u64 << 53) as f64
}

/// One socket, from handshake to close. `subs` doubles as the shutdown signal:
/// the reconcile loop drops the sender when the token disappears, and
/// `changed()` then errors.
async fn drive(
    app: &AppHandle,
    token: &str,
    tag: &str,
    conn: &mut Conn,
    subs: &mut watch::Receiver<Vec<EventSubscription>>,
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Outcome {
    let mut beat_every = Duration::from_millis(HEARTBEAT_FALLBACK_MS);
    // No HELLO yet. Discord sends one immediately on connect and closes sockets
    // that never heartbeat, so this placeholder never actually fires.
    let mut next_beat = Instant::now() + Duration::from_secs(3600);
    loop {
        let acts = tokio::select! {
            msg = ws.next() => match msg {
                None => return Outcome::Closed(1006),
                Some(Err(err)) => {
                    eprintln!("[gateway {tag}] websocket error: {err}");
                    return Outcome::Closed(1006);
                }
                Some(Ok(Message::Close(frame))) => {
                    return Outcome::Closed(frame.map_or(1006, |f| u16::from(f.code)));
                }
                Some(Ok(Message::Text(text))) => match serde_json::from_str::<Packet>(&text) {
                    Ok(pkt) => conn.on_payload(pkt),
                    Err(_) => continue, // unparseable frame — ignored, as in the TypeScript
                },
                // binary/ping/pong: tungstenite answers pings itself, and the
                // pong rides out with the next heartbeat write
                Some(Ok(_)) => continue,
            },
            _ = tokio::time::sleep_until(next_beat) => {
                next_beat = Instant::now() + beat_every;
                let act = conn.beat();
                if act == Act::Terminate {
                    eprintln!("[gateway {tag}] heartbeat not acked, reconnecting");
                }
                vec![act]
            },
            changed = subs.changed() => {
                if changed.is_err() {
                    // 1000 tells Discord to invalidate the session cleanly, so a
                    // deleted workflow's bot stops receiving immediately rather
                    // than at the server's own timeout
                    let _ = ws
                        .close(Some(CloseFrame {
                            code: CloseCode::Normal,
                            reason: Utf8Bytes::from_static(""),
                        }))
                        .await;
                    return Outcome::Shutdown;
                }
                continue; // a filter/workflow edit — the live session survives it
            },
        };

        for act in acts {
            let frame = match act {
                Act::Beat(ms) => {
                    beat_every = Duration::from_millis(ms);
                    next_beat = Instant::now() + beat_every.mul_f64(jitter());
                    continue;
                }
                Act::Identify => identify_frame(token, conn.intents),
                Act::Resume => match (conn.session_id.as_deref(), conn.seq) {
                    (Some(session), Some(seq)) => resume_frame(token, session, seq),
                    _ => identify_frame(token, conn.intents),
                },
                Act::Heartbeat => heartbeat_frame(conn.seq),
                Act::Terminate => return Outcome::Closed(1006),
                Act::Ready(username) => {
                    let n = subs.borrow().len();
                    let mode = if conn.intents & INTENT_MESSAGE_CONTENT != 0 {
                        ""
                    } else {
                        " (no message-content intent)"
                    };
                    println!(
                        "[gateway {tag}] connected as {username} ({n} subscription{}){mode}",
                        plural(n),
                    );
                    continue;
                }
                Act::Resumed => {
                    println!("[gateway {tag}] session resumed");
                    continue;
                }
                Act::Dispatch(d) => {
                    // cloned rather than borrowed: a `watch::Ref` held across the
                    // loop would make this future non-Send
                    let current = subs.borrow().clone();
                    deliver(app, tag, &current, conn.bot_user_id.as_deref(), &d);
                    continue;
                }
            };
            if ws.send(Message::Text(frame.into())).await.is_err() {
                return Outcome::Closed(1006);
            }
        }
    }
}

/// One bot token's connection for as long as it has subscriptions: connect,
/// drive, back off, reconnect. Returns only on a fatal close or a shutdown; the
/// reconcile loop keeps the map entry either way, so a token that died fatally
/// is never redialed until its *value* changes.
async fn connection(
    app: AppHandle,
    token: String,
    mut subs: watch::Receiver<Vec<EventSubscription>>,
) {
    let tag = events::fp(&token);
    let mut conn = Conn::default();
    loop {
        let base = conn.resume_gateway_url.clone().unwrap_or_else(|| GATEWAY_URL.to_string());
        let outcome = match tokio_tungstenite::connect_async(format!("{base}{GATEWAY_QUERY}")).await
        {
            Ok((mut ws, _)) => drive(&app, &token, &tag, &mut conn, &mut subs, &mut ws).await,
            Err(err) => {
                eprintln!("[gateway {tag}] websocket error: {err}");
                Outcome::Closed(1006)
            }
        };
        let Outcome::Closed(code) = outcome else {
            return;
        };
        let delay = match conn.on_close(code) {
            Close::Fatal(hint) => {
                eprintln!("[gateway {tag}] giving up: {hint}");
                return;
            }
            Close::Fallback(delay) => {
                eprintln!(
                    "[gateway {tag}] disallowed intents (4014) — retrying without \
                     message-content intent",
                );
                delay
            }
            Close::Retry(delay) => delay,
        };
        // The backoff must stay interruptible for a DELETE — a token dropped
        // during a 60s wait has to stop dialing immediately — but not for an
        // update. `reconcile` re-sends every live token's list on every 60s
        // sweep and within 2s of any workflow/variable mutation, so waking on
        // `Ok` here collapsed the whole ladder: a redial per sweep during a
        // Discord outage, and one per 2s debounce while the user is saving.
        // Discord rate-limits IDENTIFYs (1000/day) and bans past that.
        let deadline = tokio::time::Instant::now() + delay;
        loop {
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => break,
                changed = subs.changed() => if changed.is_err() { return },
            }
        }
    }
}

// --- the reconcile loop -----------------------------------------------------

fn plural(n: usize) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

/// Diffs the wanted subscription set against the live connections. Updating an
/// existing connection's subscriptions leaves its session alone, so editing a
/// filter or renaming a workflow does not drop the socket.
fn reconcile(
    app: &AppHandle,
    connections: &mut HashMap<String, watch::Sender<Vec<EventSubscription>>>,
    subs: Vec<EventSubscription>,
) {
    let mut by_token: HashMap<String, Vec<EventSubscription>> = HashMap::new();
    for sub in subs.into_iter().filter(|s| s.provider == "discord") {
        by_token.entry(sub.bot_token.clone()).or_default().push(sub);
    }

    connections.retain(|token, tx| match by_token.get(token) {
        Some(wanted) => {
            let _ = tx.send(wanted.clone());
            true
        }
        None => {
            // dropping the sender is the shutdown signal; the task closes with
            // 1000 and exits. A leaked socket here is a bot still answering for
            // a workflow the user deleted.
            println!("[gateway {}] no subscriptions left, disconnecting", events::fp(token));
            false
        }
    });

    for (token, list) in by_token {
        if connections.contains_key(&token) {
            continue;
        }
        println!(
            "[gateway {}] opening gateway connection ({} subscription{})",
            events::fp(&token),
            list.len(),
            plural(list.len()),
        );
        let (tx, rx) = watch::channel(list);
        tauri::async_runtime::spawn(connection(app.clone(), token.clone(), rx));
        connections.insert(token, tx);
    }
}

/// Starts the listener: a 60s reconciliation poll, woken early (2s debounce) by
/// any workflow or variable mutation.
pub fn start_gateway(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // created BEFORE the first read: a receiver only sees changes published
        // after it exists, so subscribing inside the loop would drop every
        // mutation landing during a poll
        let mut changed = events::on_subscriptions_changed();
        let mut connections: HashMap<String, watch::Sender<Vec<EventSubscription>>> =
            HashMap::new();
        println!("[gateway] started (poll every {}s)", POLL_INTERVAL.as_secs());
        loop {
            let store = app.state::<Store>().inner().clone();
            // the read touches SQLite and the Keychain — never a runtime worker
            let read = tauri::async_runtime::spawn_blocking(move || {
                events::get_event_subscriptions(&store, &KEYCHAIN)
            })
            .await;
            match read {
                // transient DB unavailability must not tear down live Gateway
                // sessions — keep the current connection set. Only an Ok that no
                // longer lists a token may disconnect it.
                Ok(Err(err)) => eprintln!("[gateway] subscription query failed: {err}"),
                Err(err) => eprintln!("[gateway] subscription query failed: {err}"),
                Ok(Ok(subs)) => reconcile(&app, &mut connections, subs),
            }
            tokio::select! {
                _ = tokio::time::sleep(POLL_INTERVAL) => {}
                _ = changed.changed() => {
                    // debounced so a designer autosave burst collapses into one
                    // re-poll; changes landing inside the window are swallowed by
                    // the poll it is already waiting for
                    tokio::time::sleep(REFRESH_DEBOUNCE).await;
                    changed.borrow_and_update();
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Everything here is offline: the protocol is a pure state machine and the
    /// socket layer is the only part that needs Discord. A live-socket test
    /// would need either the network or a full WebSocket server fixture, so the
    /// seam is drawn at `Act`/`Close` — `drive` is the thin untested remainder.
    fn packet(json: Value) -> Packet {
        serde_json::from_value(json).unwrap()
    }

    fn hello(interval: u64) -> Packet {
        packet(json!({ "op": 10, "d": { "heartbeat_interval": interval }, "s": null, "t": null }))
    }

    fn ready(id: &str) -> Packet {
        packet(json!({
            "op": 0, "s": 1, "t": "READY",
            "d": {
                "session_id": "sess-1",
                "resume_gateway_url": "wss://resume.discord.gg",
                "user": { "id": id, "username": "saturn", "bot": true },
            },
        }))
    }

    fn message(author: &str, mentions: Vec<&str>) -> Value {
        json!({
            "id": "444", "content": "hey @saturn", "channel_id": "222", "guild_id": "333",
            "timestamp": "2026-07-18T12:34:56.000Z",
            "author": { "id": author, "username": "ada" },
            "mentions": mentions.iter().map(|id| json!({ "id": id, "username": "saturn", "bot": true })).collect::<Vec<_>>(),
        })
    }

    fn sub(config: &[(&str, &str)]) -> EventSubscription {
        EventSubscription {
            workflow_id: "wf".into(),
            node_id: "d".into(),
            provider: "discord".into(),
            event: "discord-mentioned".into(),
            bot_token: "tok".into(),
            config: config.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        }
    }

    /// The handshake: HELLO identifies, READY records the session, and a HELLO
    /// after that resumes instead of re-identifying. Getting this wrong costs a
    /// replay of every missed message (or none of them).
    #[test]
    fn the_handshake_identifies_then_resumes() {
        let mut conn = Conn::default();
        assert_eq!(conn.on_payload(hello(41_250)), vec![Act::Beat(41_250), Act::Identify]);
        assert_eq!(conn.seq, None);

        assert_eq!(conn.on_payload(ready("bot-1")), vec![Act::Ready("saturn".into())]);
        assert_eq!(conn.seq, Some(1));
        assert_eq!(conn.session_id.as_deref(), Some("sess-1"));
        assert_eq!(conn.resume_gateway_url.as_deref(), Some("wss://resume.discord.gg"));
        assert_eq!(conn.bot_user_id.as_deref(), Some("bot-1"));

        // a reconnect: same state, so HELLO resumes
        assert_eq!(conn.on_payload(hello(41_250)), vec![Act::Beat(41_250), Act::Resume]);
        assert_eq!(conn.on_payload(packet(json!({ "op": 0, "s": 7, "t": "RESUMED", "d": null }))), vec![Act::Resumed]);
        assert_eq!(conn.seq, Some(7));

        // a HELLO with no interval must not degenerate into a hot beat loop
        assert!(matches!(
            conn.on_payload(packet(json!({ "op": 10, "d": {} }))).first(),
            Some(Act::Beat(HEARTBEAT_FALLBACK_MS)),
        ));
    }

    /// Sequence tracking and the two ways a session is thrown away. `seq` is the
    /// resume cursor *and* Discord's de-duplication mechanism — a resume replays
    /// only what came after it, which is why nothing here de-duplicates messages
    /// itself (the TypeScript did not either).
    #[test]
    fn sequence_and_session_transitions() {
        let mut conn = Conn::default();
        conn.on_payload(packet(json!({ "op": 0, "s": 4, "t": "MESSAGE_CREATE", "d": message("u", vec![]) })));
        assert_eq!(conn.seq, Some(4));
        // a null `s` leaves the cursor alone
        conn.on_payload(packet(json!({ "op": 11, "s": null, "d": null })));
        assert_eq!(conn.seq, Some(4));

        conn.on_payload(ready("bot-1"));
        // INVALID_SESSION, resumable: keep the session and try again
        assert_eq!(conn.on_payload(packet(json!({ "op": 9, "d": true }))), vec![Act::Terminate]);
        assert_eq!(conn.session_id.as_deref(), Some("sess-1"));
        // INVALID_SESSION, not resumable: start over, including the resume host
        assert_eq!(conn.on_payload(packet(json!({ "op": 9, "d": false }))), vec![Act::Terminate]);
        assert_eq!((conn.session_id, conn.seq, conn.resume_gateway_url), (None, None, None));

        // RECONNECT terminates but keeps the session, so the redial resumes
        let mut conn = Conn::default();
        conn.on_payload(ready("bot-1"));
        assert_eq!(conn.on_payload(packet(json!({ "op": 7, "d": null }))), vec![Act::Terminate]);
        assert!(conn.session_id.is_some());

        // an unknown opcode is ignored, not fatal
        assert!(conn.on_payload(packet(json!({ "op": 42, "d": null }))).is_empty());
        assert!(conn.on_payload(packet(json!({ "op": 0, "t": "TYPING_START", "d": {} }))).is_empty());
    }

    /// The zombie check. A socket whose heartbeat is never ACKed is up at the TCP
    /// level and dead at the application level; without this the bot goes silent
    /// with no error anywhere.
    #[test]
    fn an_unacked_heartbeat_terminates_the_socket() {
        let mut conn = Conn::default();
        assert_eq!(conn.beat(), Act::Heartbeat);
        assert!(conn.awaiting_ack);
        assert_eq!(conn.beat(), Act::Terminate, "an unacked beat must reconnect");
        assert!(!conn.awaiting_ack, "the flag must reset or every later beat terminates");

        // an ACK clears it, so the next beat is a normal one
        conn.beat();
        conn.on_payload(packet(json!({ "op": 11, "d": null })));
        assert_eq!(conn.beat(), Act::Heartbeat);
        // op 1 is the server asking for one out of band — it does not arm the
        // zombie check (a missing ACK for it would be a false positive)
        let mut conn = Conn::default();
        assert_eq!(conn.on_payload(packet(json!({ "op": 1, "d": null }))), vec![Act::Heartbeat]);
        assert!(!conn.awaiting_ack);
    }

    /// Close-code classification and the backoff ladder — the two things that
    /// decide whether a bad token hammers Discord forever.
    #[test]
    fn close_codes_and_the_backoff_ladder() {
        let mut conn = Conn::default();
        let secs = |c: Close| match c {
            Close::Retry(d) | Close::Fallback(d) => d.as_secs(),
            Close::Fatal(hint) => panic!("expected a retry, got: {hint}"),
        };
        // 1s doubling to a 60s ceiling and staying there
        for expected in [1, 2, 4, 8, 16, 32, 60, 60] {
            assert_eq!(secs(conn.on_close(1006)), expected);
        }
        // a READY resets the ladder
        conn.on_payload(ready("bot-1"));
        assert_eq!(secs(conn.on_close(1006)), 1);
        // and so does a RESUMED
        conn.on_close(1006);
        conn.on_payload(packet(json!({ "op": 0, "s": 2, "t": "RESUMED", "d": null })));
        assert_eq!(secs(conn.on_close(1006)), 1);

        for code in FATAL_CLOSE_CODES {
            let mut conn = Conn::default();
            assert!(matches!(conn.on_close(code), Close::Fatal(_)), "{code} must be fatal");
        }
        assert!(matches!(Conn::default().on_close(4004), Close::Fatal(h) if h.contains("bot token")));
        // retryable: a server-side blip, a 4000 unknown error, a 4009 timeout
        for code in [1000, 1001, 1006, 4000, 4009] {
            assert!(matches!(Conn::default().on_close(code), Close::Retry(_)), "{code}");
        }
    }

    /// The 4014 fallback: one downgrade, then fatal. Retrying with the intent
    /// still on would loop forever against a bot whose owner never enabled it.
    #[test]
    fn the_4014_fallback_downgrades_once() {
        let mut conn = Conn::default();
        conn.on_payload(ready("bot-1"));
        assert!(conn.intents & INTENT_MESSAGE_CONTENT != 0);

        assert!(matches!(conn.on_close(4014), Close::Fallback(_)));
        assert_eq!(conn.intents, INTENT_GUILD_MESSAGES);
        // the session is thrown away — the identify it belonged to was rejected
        assert_eq!((conn.session_id.clone(), conn.seq, conn.resume_gateway_url.clone()), (None, None, None));
        // the retried identify carries the reduced intents
        assert!(identify_frame("t", conn.intents).contains(r#""intents":512"#));

        // a second 4014 is the real answer: the bot cannot read messages at all
        assert!(matches!(conn.on_close(4014), Close::Fatal(h) if h.contains("developers")));
    }

    /// The three frames that carry the token, byte for byte — a malformed
    /// identify is rejected with a 4002 that this port would classify as
    /// retryable and loop on.
    #[test]
    fn frames_encode_exactly() {
        assert_eq!(
            identify_frame("bot-token", INTENT_GUILD_MESSAGES | INTENT_MESSAGE_CONTENT),
            r#"{"d":{"intents":33280,"properties":{"browser":"saturn","device":"saturn","os":"linux"},"token":"bot-token"},"op":2}"#,
        );
        assert_eq!(
            resume_frame("bot-token", "sess-1", 9),
            r#"{"d":{"seq":9,"session_id":"sess-1","token":"bot-token"},"op":6}"#,
        );
        assert_eq!(heartbeat_frame(Some(9)), r#"{"d":9,"op":1}"#);
        assert_eq!(heartbeat_frame(None), r#"{"d":null,"op":1}"#);

        // the state machine never holds the token, so no `{:?}` of it can leak one
        let mut conn = Conn::default();
        conn.on_payload(ready("bot-1"));
        assert!(!format!("{conn:?}").contains("bot-token"));
    }

    /// `fp` is the only shape a token may take in output. Ported from the
    /// TypeScript's `token.slice(-4)`, which cannot panic — neither may this, on
    /// a short, empty or multibyte token. Every log line in this module goes
    /// through it, so a panic here would take the connection down.
    #[test]
    fn fp_never_panics_and_never_shows_more_than_four() {
        assert_eq!(events::fp("MTIzNDU2Nzg5.GhIjKl.abcd1234"), "…1234");
        assert_eq!(events::fp("abcd"), "…abcd");
        assert_eq!(events::fp("ab"), "…ab", "a short token must not panic");
        assert_eq!(events::fp(""), "…");
        // 4 UTF-16 units, not 4 bytes and not 4 chars: an astral character is a
        // surrogate pair, and a byte slice would cut one in half
        assert_eq!(events::fp("tok😀"), "…ok😀", "an emoji is two units, as in JS");
        assert_eq!(events::fp("😀😀😀"), "…😀😀");
        // the cut lands inside a surrogate pair: JS keeps the lone low surrogate,
        // Rust strings cannot hold one and it becomes U+FFFD. The single
        // unavoidable difference, and harmless — this is a log label
        assert_eq!(events::fp("x😀abc"), "…\u{fffd}abc");
    }

    /// Who a message goes to: the loop guard, the mention match, and the two
    /// optional filters.
    #[test]
    fn a_message_reaches_only_its_matching_subscriptions() {
        let all = vec![sub(&[]), sub(&[("guildId", "333")]), sub(&[("channelId", "222")])];
        let msg = |v: Value| serde_json::from_value::<MessageData>(v).unwrap();

        assert_eq!(matching(&all, "bot-1", &msg(message("ada", vec!["bot-1"]))).len(), 3);
        // no mention of *this* bot: someone else's ping, or a role/@everyone one
        assert!(matching(&all, "bot-1", &msg(message("ada", vec!["bot-2"]))).is_empty());
        assert!(matching(&all, "bot-1", &msg(message("ada", vec![]))).is_empty());
        // the loop guard: a bot author never dispatches, even mentioning us
        let mut from_bot = message("ada", vec!["bot-1"]);
        from_bot["author"]["bot"] = json!(true);
        assert!(matching(&all, "bot-1", &msg(from_bot)).is_empty());

        // filters that do not match drop only their own subscription
        let mut elsewhere = message("ada", vec!["bot-1"]);
        elsewhere["guild_id"] = json!("999");
        elsewhere["channel_id"] = json!("888");
        assert_eq!(matching(&all, "bot-1", &msg(elsewhere)).len(), 1);
        // a DM has no guild at all, so a guild filter cannot match it
        let mut dm = message("ada", vec!["bot-1"]);
        dm["guild_id"] = json!(null);
        assert_eq!(matching(&all, "bot-1", &msg(dm)).len(), 2);
    }

    /// The payload contract every graph destructures: keys, key order, and never
    /// over the spine's cap. The designer's sample is the same function over a
    /// canned mention, so it is pinned here too.
    #[test]
    fn the_payload_mirrors_the_sample() {
        let msg: MessageData = serde_json::from_value(message("111", vec!["bot-1"])).unwrap();
        assert_eq!(
            event_payload(&msg),
            r#"{"content":"hey @saturn","authorId":"111","authorUsername":"ada","channelId":"222","guildId":"333","messageId":"444","timestamp":"2026-07-18T12:34:56.000Z"}"#,
        );
        assert_eq!(
            sample_payload(),
            r#"{"content":"hey @saturn, summarize today's thread","authorId":"111111111111111111","authorUsername":"ada","channelId":"222222222222222222","guildId":"333333333333333333","messageId":"444444444444444444","timestamp":"2026-07-18T12:34:56.000Z"}"#,
        );

        // a DM's absent guild is "", not null — the sample has no null in it
        let mut dm_value = message("111", vec!["bot-1"]);
        dm_value["guild_id"] = json!(null);
        let dm: MessageData = serde_json::from_value(dm_value).unwrap();
        assert!(event_payload(&dm).contains(r#""guildId":"""#));

        // an impossible-but-guarded oversized message is cut to MAX_CONTENT
        // rather than rejected by the spine's shape check
        let mut huge_value = message("111", vec!["bot-1"]);
        huge_value["content"] = json!("x".repeat(MAX_EVENT_PAYLOAD + 1));
        let huge: MessageData = serde_json::from_value(huge_value).unwrap();
        let payload = event_payload(&huge);
        assert!(payload.encode_utf16().count() <= MAX_EVENT_PAYLOAD);
        assert!(payload.contains(&"x".repeat(MAX_CONTENT)));
    }
}
