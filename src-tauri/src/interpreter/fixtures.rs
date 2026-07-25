//! The golden-fixture oracle, from the Rust side.
//!
//! `fixtures/expected/*.json` is the frozen output of the TypeScript
//! interpreter under the deterministic stubs in `fixtures/run.mjs`. This test
//! replays every case through the Rust interpreter with stubs reimplemented to
//! match those byte for byte, and compares the serialized transcript to the
//! committed file. When the two disagree the Rust is wrong.
//!
//! Most cases cannot run yet — three node types are ported, seventeen exist.
//! A skipped case is NOT a pass: the summary names every skip and the node type
//! that caused it, so Phase C can watch the count fall. It prints under
//! `cargo test -- --nocapture`.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::sync::mpsc::channel;

use serde_json::{json, Value};

use super::{run_inner, CATALOG};

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures");
// run.mjs elides long arrays so a 10k-step case is not a 400 KB expected file
const CAP: usize = 500;

// --- stubs (fixtures/run.mjs) ----------------------------------------------

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

/// run.mjs `callIntegration`, for the one provider this slice implements. The
/// interpreter passes the merged config; the separate `message` param is
/// `node.config.message` for http-request (it has no message port or field).
fn stub_send(config: &HashMap<String, String>) -> Result<String, String> {
    match config.get("stub").map(String::as_str) {
        Some("error") => Err("stub http-request refused".into()),
        // 3 UTF-16 units per group, so MAX_RESULT_CHARS cuts mid-surrogate-pair
        Some("big") => Ok("y🚀".repeat(700)),
        _ => Ok(format!(
            "sent:http-request cfg={} msg={}",
            digest(&canon(config)),
            digest(config.get("message").map_or("", String::as_str)),
        )),
    }
}

// --- what this port can still not run --------------------------------------

/// The node types the Rust interpreter implements. Anything else in the catalog
/// aborts the run naming itself, so a case containing one cannot be compared.
/// An *uncatalogued* type is not a blocker — both interpreters skip it.
fn blocker(node_type: &str) -> Option<String> {
    match CATALOG.get(node_type) {
        None => None,
        Some(_) if node_type == "print" || node_type == "integration:http-request" => None,
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

        // registry-backed types (mcp / skill / memory / variable chips) come
        // from a user registry the Rust has none of — every one is unported
        let mut blockers: Vec<String> = spec["entries"]
            .as_array()
            .map(|es| {
                es.iter()
                    .map(|e| e["key"].as_str().unwrap_or("?").to_string())
                    .collect()
            })
            .unwrap_or_default();
        for node in spec["graph"]["nodes"].as_array().unwrap() {
            if let Some(b) = blocker(node["type"].as_str().unwrap()) {
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
        let values = run_inner(
            &graph,
            entry_ids.as_deref(),
            payloads.as_ref(),
            &tx,
            stub_send,
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
