//! The golden-fixture oracle, from the Rust side.
//!
//! `fixtures/expected/*.json` is the frozen output of the TypeScript
//! interpreter under a set of deterministic stubs. This test replays every case
//! through the Rust interpreter with those stubs reimplemented below, and
//! compares the serialized transcript to the committed file. When the two
//! disagree the Rust is wrong.
//!
//! The TypeScript that produced `expected/` — and the harness that ran it — are
//! deleted. There is no second implementation left, so `expected/` cannot be
//! regenerated and this test is the only thing that reads it. That is the point:
//! see `fixtures/README.md`.
//!
//! A skipped case is NOT a pass: the summary names every skip and the node type
//! that caused it, so a half-finished port cannot hide behind a green run. As of
//! the end of Phase C the count is zero, and `PORTED` is what keeps it honest
//! when a new node type lands. It prints under `cargo test -- --nocapture`.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::sync::mpsc::channel;

use serde_json::{json, Value};

use super::{run_workflow, CatalogEntry, Effects, CATALOG};
use crate::agent::{content, role, Request, Turn};
use crate::openrouter::ToolCall;

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures");
// the oracle elided long arrays so a 10k-step case is not a 400 KB expected file
const CAP: usize = 500;

// --- stubs (ported from the deleted oracle) --------------------------------

/// FNV-1a over UTF-16 code units, prefixed with the `.length` the interpreter's
/// truncation counts. Measuring bytes or `char`s fails here loudly instead of
/// silently at the 2000-char boundary.
fn digest(s: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    let mut units = 0usize;
    for u in s.encode_utf16() {
        h = (h ^ u32::from(u)).wrapping_mul(0x0100_0193);
        units += 1;
    }
    format!("{units}#{h:08x}")
}

/// `JSON.stringify(o, Object.keys(o).sort())` — key-sorted so a HashMap can
/// reproduce it. Config keys are ASCII, where JS's UTF-16 sort and Rust's byte
/// sort agree.
fn canon(config: &HashMap<String, String>) -> String {
    let sorted: BTreeMap<&str, &str> = config.iter().map(|(k, v)| (&**k, &**v)).collect();
    serde_json::to_string(&sorted).unwrap()
}

/// The oracle's `callIntegration` stub. The provider id and the resolved message are the
/// interpreter's own arguments, so a port that drops either — or reads the
/// message out of the config map instead — fails here.
fn stub_send(
    provider: &str,
    config: &HashMap<String, String>,
    message: &str,
) -> Result<String, String> {
    match config.get("stub").map(String::as_str) {
        Some("error") => Err(format!("stub {provider} refused")),
        // 3 UTF-16 units per group, so MAX_RESULT_CHARS cuts mid-surrogate-pair
        Some("big") => Ok("y🚀".repeat(700)),
        _ => Ok(format!(
            "sent:{provider} cfg={} msg={}",
            digest(&canon(config)),
            digest(message),
        )),
    }
}

/// The oracle's `callMcp` / `callMemory` stubs. The interpreter decides which one a granted
/// tool call routes to; only the MCP side has the steering tool names.
fn stub_tool(memory: bool, entry_id: &str, tool: &str, input: &str) -> Result<String, String> {
    if memory {
        return Ok(format!("mem:{entry_id}/{tool}({})", digest(input)));
    }
    match tool {
        "boom" => Err(format!("stub mcp refused {entry_id}")),
        "big" => Ok("x".repeat(30_000)),
        _ => Ok(format!("mcp:{entry_id}/{tool}({})", digest(input))),
    }
}

/// `JSON.stringify(req, Object.keys(req).sort())`. A property-list replacer
/// applies at EVERY nesting level, and none of the request's own key names are
/// message or tool-ref key names — so every nested object serializes as `{}` and
/// only the array lengths survive. The key order is the sorted top-level key
/// list, with the two optional keys dropped when undefined.
fn canon_request(req: &Request) -> String {
    let q = |s: &str| serde_json::to_string(s).unwrap();
    let empties = |n: usize| vec!["{}"; n].join(",");
    let mut parts = Vec::new();
    if let Some(id) = &req.memory_id {
        parts.push(format!("\"memoryId\":{}", q(id)));
    }
    parts.push(format!("\"messages\":[{}]", empties(req.messages.len())));
    parts.push(format!("\"model\":{}", q(&req.model)));
    parts.push(format!("\"outputImage\":{}", req.output_image));
    if let Some(r) = &req.reasoning {
        parts.push(format!("\"reasoning\":{}", q(r)));
    }
    let skills: Vec<String> = req.skill_ids.iter().map(|s| q(s)).collect();
    parts.push(format!("\"skillIds\":[{}]", skills.join(",")));
    parts.push(format!("\"system\":{}", q(&req.system)));
    parts.push(format!("\"tools\":[{}]", empties(req.tools.len())));
    format!("{{{}}}", parts.join(","))
}

/// The oracle's `callAgent` stub. Cases steer it through values they control: the model
/// slug "stub-error", and a prompt prefixed "TOOL "/"MANY "/"MEM "/"IMG ".
fn stub_model(req: &Request) -> Turn {
    if req.model == "stub-error" {
        return Turn::Failed("stub model failure".into());
    }
    let first = content(&req.messages[0]);
    let fresh = req.messages.last().is_some_and(|m| role(m) == "user");
    let call = |i: usize| ToolCall {
        // the wire call id never reaches the frozen transcripts (a message
        // serializes as `{}` there) — a fixed one keeps the stub deterministic
        id: format!("call_{i}"),
        entry_id: req
            .tools
            .first()
            .map(|t| t.entry_id.clone())
            .or_else(|| req.memory_id.clone())
            .unwrap_or_else(|| "none".into()),
        tool_name: first[first.find(' ').map_or(0, |i| i + 1)..].to_string(),
        arguments: format!("{{\"i\":{i}}}"),
    };
    let reply = |tool_calls, image| Turn::Reply { content: String::new(), tool_calls, image };
    if fresh && first.starts_with("TOOL ") {
        return reply(vec![call(0)], None);
    }
    if fresh && first.starts_with("MANY ") {
        return reply((0..7).map(call).collect(), None);
    }
    // an output=image agent whose model returns no image falls back to text, so
    // both paths need steering
    if req.output_image && first.starts_with("IMG ") {
        return reply(vec![], Some(format!("data:image/png;base64,{}", "Q".repeat(4001))));
    }
    if fresh && first.starts_with("MEM ") {
        let to_store = ToolCall {
            entry_id: req.memory_id.clone().unwrap_or_else(|| "none".into()),
            ..call(0)
        };
        return reply(vec![to_store], None);
    }
    // the transcript shape is the thing a port most easily gets wrong, so report
    // both readable per-message lengths and a hash of the whole request
    let shape: Vec<String> = req
        .messages
        .iter()
        .map(|m| format!("{}:{}", role(m), content(m).encode_utf16().count()))
        .collect();
    Turn::Reply {
        content: format!("agent[{}]({})", shape.join(","), digest(&canon_request(req))),
        tool_calls: vec![],
        image: None,
    }
}

// --- what this port can still not run --------------------------------------

/// The node types the Rust interpreter implements. A catalogued type that is not
/// here has no arm, so it falls to the warn-and-skip default and the case cannot
/// be compared — `PORTED` is what turns that into a reported skip rather than a
/// silent pass. An *uncatalogued* type is not a blocker: both interpreters warn
/// and walk on. A case's own `entries` are the user registry, overlaid for real.
fn blocker(node_type: &str, registry: &HashMap<String, CatalogEntry>) -> Option<String> {
    if registry.contains_key(node_type) {
        return None;
    }
    match CATALOG.get(node_type) {
        None => None,
        Some(_) if super::PORTED.contains(&node_type) => None,
        Some(e) if e.category == "events" => None,
        Some(_) => Some(node_type.to_string()),
    }
}

// --- comparison -------------------------------------------------------------

fn elide(mut v: Vec<Value>) -> Vec<Value> {
    if v.len() <= CAP {
        return v;
    }
    let n = v.len();
    let tail = v.split_off(n - 19);
    v.truncate(480);
    v.push(json!(format!("… {} elided …", n - CAP)));
    v.extend(tail);
    v
}

/// A JS `.slice()` that cuts a surrogate pair leaves a lone surrogate, which
/// `JSON.stringify` writes as `\udXXX` and a Rust `String` cannot hold at all —
/// `String::from_utf16_lossy` yields U+FFFD there. Fold those escapes in the
/// expected text so everything around them still has to match exactly. Counted
/// and reported: it is the one known, unfixable divergence.
fn fold_lone_surrogates(s: &str) -> (String, usize) {
    let (b, mut out, mut i, mut folded) = (s.as_bytes(), String::with_capacity(s.len()), 0, 0);
    while i < b.len() {
        if b[i] != b'\\' {
            let ch = s[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }
        // a non-\u escape is two bytes and must be stepped over whole, or a
        // literal backslash before "uXXXX" would read as an escape
        if i + 6 > b.len() || b[i + 1] != b'u' {
            out.push_str(&s[i..(i + 2).min(b.len())]);
            i += 2;
            continue;
        }
        // byte-wise: the text around an escape is arbitrary UTF-8, so string
        // slicing here would cut a multi-byte char
        let esc = |at: usize| {
            (at + 6 <= b.len() && b[at] == b'\\' && b[at + 1] == b'u')
                .then(|| std::str::from_utf8(&b[at + 2..at + 6]).ok())
                .flatten()
                .and_then(|h| u32::from_str_radix(h, 16).ok())
        };
        let cp = esc(i).unwrap_or(0);
        let low = |at: usize| esc(at).is_some_and(|c| (0xDC00..0xE000).contains(&c));
        if (0xD800..0xDC00).contains(&cp) && low(i + 6) {
            out.push_str(&s[i..i + 12]); // a well-formed pair, left alone
            i += 12;
        } else if (0xD800..0xE000).contains(&cp) {
            out.push('\u{fffd}'); // serde_json writes it raw, not as an escape
            folded += 1;
            i += 6;
        } else {
            out.push_str(&s[i..i + 6]);
            i += 6;
        }
    }
    (out, folded)
}

fn first_diff(want: &str, got: &str) -> String {
    let (a, b): (Vec<&str>, Vec<&str>) = (want.lines().collect(), got.lines().collect());
    let mut out = String::new();
    for i in 0..a.len().max(b.len()) {
        if a.get(i) == b.get(i) {
            continue;
        }
        if out.lines().count() >= 20 {
            out.push_str("  …\n");
            break;
        }
        if let Some(l) = a.get(i) {
            out.push_str(&format!("  {} - {l}\n", i + 1));
        }
        if let Some(l) = b.get(i) {
            out.push_str(&format!("  {} + {l}\n", i + 1));
        }
    }
    out
}

#[test]
fn golden_fixtures() {
    let mut names: Vec<String> = fs::read_dir(format!("{DIR}/cases"))
        .expect("fixtures/cases")
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();

    let (mut ran, mut folded_cases) = (0usize, Vec::new());
    let (mut skipped, mut failures) = (Vec::new(), Vec::new());
    let mut by_type: BTreeMap<String, usize> = BTreeMap::new();

    for file in &names {
        let name = file.trim_end_matches(".json").to_string();
        let spec: Value =
            serde_json::from_str(&fs::read_to_string(format!("{DIR}/cases/{file}")).unwrap())
                .unwrap();

        // a case's `entries` are the user's registry (mcp / skill / memory /
        // variable chips), overlaid on the catalog exactly as `byKey` was
        let registry: HashMap<String, CatalogEntry> = spec["entries"]
            .as_array()
            .map(|es| {
                es.iter()
                    .map(|e| {
                        let entry: CatalogEntry = serde_json::from_value(e.clone()).unwrap();
                        (entry.key.clone(), entry)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let mut blockers: Vec<String> = Vec::new();
        for node in spec["graph"]["nodes"].as_array().unwrap() {
            if let Some(b) = blocker(node["type"].as_str().unwrap(), &registry) {
                blockers.push(b);
            }
        }
        blockers.sort();
        blockers.dedup();
        if !blockers.is_empty() {
            for b in &blockers {
                *by_type.entry(b.clone()).or_default() += 1;
            }
            skipped.push((name, blockers.join(", ")));
            continue;
        }

        ran += 1;
        let graph = serde_json::from_value(spec["graph"].clone()).unwrap();
        let entry_ids: Option<Vec<String>> = spec["entryNodeIds"]
            .as_array()
            .map(|a| a.iter().map(|v| v.as_str().unwrap().to_string()).collect());
        let payloads: Option<HashMap<String, String>> = spec["eventPayloads"].as_object().map(|o| {
            o.iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
                .collect()
        });

        let (tx, rx) = channel();
        let values = run_workflow(
            &graph,
            entry_ids.as_deref(),
            payloads.as_ref(),
            Some(&registry),
            &tx,
            Effects { send: &stub_send, model: &stub_model, tool: &stub_tool },
            None,
        );
        drop(tx);
        let console: Vec<Value> = rx.into_iter().map(|l| json!(l)).collect();
        let values: Vec<Value> = values.into_iter().map(|(n, p, t)| json!([n, p, t])).collect();
        let got = format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({
                "console": elide(console),
                "values": elide(values),
            }))
            .unwrap()
        );

        let (want, folded) =
            fold_lone_surrogates(&fs::read_to_string(format!("{DIR}/expected/{name}.json")).unwrap());
        if folded > 0 {
            folded_cases.push(format!("{name} ({folded})"));
        }
        if want != got {
            failures.push(format!("FAIL {name}\n{}", first_diff(&want, &got)));
        }
    }

    println!(
        "\n{} fixtures: {ran} run, {} skipped",
        names.len(),
        skipped.len()
    );
    for (name, why) in &skipped {
        println!("  skip {name:<24} {why}");
    }
    println!(
        "unported node types blocking a case: {}",
        by_type
            .iter()
            .map(|(t, n)| format!("{t}({n})"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    if !folded_cases.is_empty() {
        println!(
            "compared modulo lone surrogate → U+FFFD: {}",
            folded_cases.join(", ")
        );
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
