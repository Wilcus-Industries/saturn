//! The model providers. A provider is a const row, not a database entity: two
//! rows today, each carrying only what the send path needs.
//!
//! Claude Code is reached through a local OpenAI-compatible server
//! (schmarta/claude-code-openai-server) driving the `claude` CLI, so it needs no
//! second HTTP client and no second key — `openrouter.rs` speaks the same wire
//! format at a different URL. The base URL is hardcoded on loopback: the server
//! refuses to start off-loopback without a key of its own, which is also why the
//! bearer Saturn sends it is a dummy (`runner::model_key`).
//!
//! Routing is by slug prefix — `claude-code/opus` runs on Claude Code as `opus`,
//! everything else is OpenRouter unchanged. `runner::valid_model_id` already
//! permits `/`, so graphs, fixtures and the model picker need no new shape.
//!
//! Blocking reqwest (the probe): callers must be on a plain std thread.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::blocking::Client;
use serde_json::Value;

use crate::openrouter::Model;

pub struct Provider {
    pub id: &'static str,
    pub name: &'static str,
    pub chat_url: &'static str,
    pub timeout: Duration,
    /// send OpenRouter's own body keys (`reasoning`, `modalities`)? The Claude
    /// Code server's request model has no such fields.
    pub extras: bool,
}

/// A non-streaming completion that hasn't landed in 60s is hung: the
/// interpreter's run thread and the workflow's whole step are blocked on it, so
/// waiting longer just holds a run open. Set explicitly because reqwest's
/// blocking client defaults to a 30s timeout — inheriting that default would
/// silently halve the budget and cut slow reasoning models off mid-thought.
pub static OPENROUTER: Provider = Provider {
    id: "openrouter",
    name: "OpenRouter",
    chat_url: "https://openrouter.ai/api/v1/chat/completions",
    timeout: Duration::from_secs(60),
    extras: true,
};

/// 600s is the server's own `CCI_REQUEST_TIMEOUT_S`: it boots a Node subprocess
/// and an MCP handshake per turn, so 60s would time out turns it will finish.
pub static CLAUDE_CODE: Provider = Provider {
    id: "claude-code",
    name: "Claude Code",
    chat_url: "http://127.0.0.1:8787/v1/chat/completions",
    timeout: Duration::from_secs(600),
    extras: false,
};

const CLAUDE_CODE_MODELS_URL: &str = "http://127.0.0.1:8787/v1/models";
const PREFIX: &str = "claude-code/";

/// (provider, wire model). The prefix is stripped exactly once, so
/// `claude-code/a/b` goes on the wire as `a/b`; a bare slug is OpenRouter's.
pub fn resolve(model: &str) -> (&'static Provider, &str) {
    match model.strip_prefix(PREFIX) {
        Some(wire) => (&CLAUDE_CODE, wire),
        None => (&OPENROUTER, model),
    }
}

/// A 2s budget: this runs on the Settings page load and on every model-picker
/// fetch, and the server is either on loopback (instant) or absent (refused
/// instantly, or dropped by a firewall — which is the case this bounds).
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const PROBE_TTL: Duration = Duration::from_secs(30);

/// Same shape as `openrouter::list_models`' cache, with one deliberate
/// difference: the *negative* result is cached too. OpenRouter's isn't, because
/// a failed fetch there is a blip worth retrying; here "not running" is the
/// steady state for most users, and re-probing per call would cost 2s on every
/// Settings render and every model-picker open.
static PROBE: Mutex<Option<(Instant, Option<Vec<Model>>)>> = Mutex::new(None);

/// Claude Code's catalogue, or `None` when the server isn't reachable — which is
/// also how the Settings tile decides it is disconnected.
///
/// `refresh` skips the TTL. The Settings modal's re-check button is pressed by
/// someone who *just* started the server, so honouring a 30s negative cache
/// there would answer "still not detected" to a question whose whole point is
/// that the answer changed.
///
/// Blocking reqwest: the caller must be on a plain std thread.
pub fn probe_claude_code(refresh: bool) -> Option<Vec<Model>> {
    // `into_inner` on poison, not `unwrap`: the lock is held across a network
    // call, and a panic under it would otherwise wedge the probe for the life of
    // the process.
    let mut cache = PROBE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, models)) = cache.as_ref() {
        if !refresh && at.elapsed() < PROBE_TTL {
            return models.clone();
        }
    }
    let models = fetch_claude_code_models();
    *cache = Some((Instant::now(), models.clone()));
    models
}

fn fetch_claude_code_models() -> Option<Vec<Model>> {
    let client = Client::builder().timeout(PROBE_TIMEOUT).build().ok()?;
    let res = client.get(CLAUDE_CODE_MODELS_URL).send().ok()?;
    if !res.status().is_success() {
        return None;
    }
    Some(parse_models(&res.json::<Value>().ok()?))
}

/// The OpenAI `/v1/models` shape — `{data:[{id}]}` — not OpenRouter's, which
/// carries an architecture and a parameter list. Claude Code is text-only and
/// exposes no reasoning parameter, so both flags are constants.
///
/// Ids are filtered through `valid_model_id` *after* prefixing: the prefixed
/// slug is what a graph stores and what goes back on the wire, so a row this
/// accepts is a row that can actually run.
fn parse_models(body: &Value) -> Vec<Model> {
    let data = body.get("data").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    data.iter()
        .filter_map(|m| {
            let raw = m.get("id").and_then(Value::as_str)?;
            let id = format!("{PREFIX}{raw}");
            crate::runner::valid_model_id(&id).then(|| Model {
                // the bare id: the picker groups by provider, so a "Claude Code"
                // prefix here would just repeat the section heading above it
                name: raw.to_string(),
                id,
                output_modalities: vec!["text".to_string()],
                supports_reasoning: false,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_route_by_prefix_and_parse_to_runnable_ids() {
        assert_eq!(resolve("claude-code/opus").0.id, "claude-code");
        assert_eq!(resolve("claude-code/opus").1, "opus");
        // stripped once, not greedily
        assert_eq!(resolve("claude-code/a/b").1, "a/b");
        assert_eq!(resolve("anthropic/claude-sonnet-4.5").0.id, "openrouter");
        assert_eq!(resolve("anthropic/claude-sonnet-4.5").1, "anthropic/claude-sonnet-4.5");
        // a bare slug is OpenRouter's, not Claude Code's
        assert_eq!(resolve("opus").0.id, "openrouter");

        let models = parse_models(&serde_json::json!({ "data": [
            { "id": "opus" },
            { "id": 7 },                        // not a string
            { "id": "sonnet\" }" },             // junk an id may never carry
            { "id": "x".repeat(200) },          // past MODEL_ID's length cap
        ]}));
        assert_eq!(models.len(), 1, "junk rows survived: {models:?}");
        assert_eq!(models[0].id, "claude-code/opus");
        assert_eq!(models[0].output_modalities, ["text"]);
        assert!(!models[0].supports_reasoning);
        assert!(parse_models(&serde_json::json!({})).is_empty());
    }
}
