//! The save-time half of `lib/workflow.ts`: the absolute graph caps and the
//! shape guard the designer's autosave has to pass.
//!
//! The *runtime* graph model lives in `interpreter.rs` and is deliberately
//! lenient — serde ignores unknown fields, tolerates duplicate node ids and
//! never looks at `x`/`y`, because a graph that is already in the database must
//! keep running. This module is the other end: it decides what is allowed to
//! get *into* the database in the first place, so it is strict about exactly the
//! things a designer bug or a hand-written graph could break.
//!
//! `graphShapeError` returned a message; `saveWorkflow` threw a flat
//! "Invalid graph" and dropped it on the floor. Only the boolean is ported —
//! the messages exist for the MCP tools, which are Phase G.
//!
//! It also owns `validate_graph_strict`, the *deep* validator the designer's
//! issues panel and Saturn's `save_graph` tool both read. It lives here because
//! this module already decides what a graph may contain and already carries the
//! caps its messages quote. `check_graph` still gates every save on its own —
//! the designer autosaves half-wired graphs constantly, so a strict finding is
//! advice, never a rejection.
//!
//! `fixtures/validation.json` is its frozen specification: 30 cases captured
//! from the TypeScript `validateGraphStrict` before it was deleted, asserted
//! whole by `validation_golden`. The oracle is gone, so a diff means the Rust
//! is wrong unless the semantics were deliberately changed in the same commit.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::Value;

use crate::agent;
use crate::events::STATIC_VALUE_TYPES;
use crate::interpreter::{CatalogEntry, Graph, Node};
use crate::runner::is_valid_cron;

// absolute caps — they were never per-plan, so the tier deletion leaves them
pub const MAX_NODES: usize = 300;
pub const MAX_EDGES: usize = 600;
pub const MAX_GRAPH_JSON: usize = 262_144;
const MAX_NODE_TYPE_LENGTH: usize = 128;

/// JS `.length` on a string counts UTF-16 units, not bytes or chars.
fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `{nodeId, portId}`, both strings. Port *ids* are not checked: registry node
/// types resolve per-user at read time, so nothing here can know their port
/// lists.
fn is_port_ref(x: Option<&Value>) -> bool {
    x.and_then(Value::as_object).is_some_and(|o| {
        o.get("nodeId").is_some_and(Value::is_string) && o.get("portId").is_some_and(Value::is_string)
    })
}

/// The whole save-time gate — shape, then the two count caps, then the
/// serialized-size cap — returning the JSON to store. Every write to
/// `workflow.graph` goes through this: `set_graph` for the designer's autosave
/// and `create_workflow_with` for a create that carries one. A path that skipped
/// it would land a row `execute_run` cannot deserialize.
pub fn check_graph(g: &Value) -> Result<String, String> {
    if !is_workflow_graph(g) {
        return Err("Invalid graph".into());
    }
    let (nodes, edges) = (g["nodes"].as_array(), g["edges"].as_array());
    if nodes.is_some_and(|n| n.len() > MAX_NODES) || edges.is_some_and(|e| e.len() > MAX_EDGES) {
        return Err("Graph too large".into());
    }
    let json = serde_json::to_string(g).map_err(|e| e.to_string())?;
    // the TypeScript capped `JSON.stringify(graph).length`, i.e. UTF-16 units of
    // ITS serialization. serde_json escapes the same set of characters, but
    // `serde_json::Map` sorts keys where JS preserved insertion order — the
    // length is identical, the bytes are not.
    if json.encode_utf16().count() > MAX_GRAPH_JSON {
        return Err("Graph too large".into());
    }
    Ok(json)
}

/// Port of `isWorkflowGraph`. Node *types* are not validated against the catalog
/// on purpose — an unknown type renders as an inert "(deleted)" placeholder, and
/// rejecting them would brick every saved graph the moment a registry entry is
/// removed or a catalog entry is retired.
pub fn is_workflow_graph(g: &Value) -> bool {
    let Some(g) = g.as_object() else { return false };
    let (Some(nodes), Some(edges)) = (
        g.get("nodes").and_then(Value::as_array),
        g.get("edges").and_then(Value::as_array),
    ) else {
        return false;
    };

    let mut node_ids = std::collections::HashSet::new();
    for n in nodes {
        let Some(n) = n.as_object() else { return false };
        let Some(id) = n.get("id").and_then(Value::as_str) else { return false };
        if !node_ids.insert(id) {
            return false; // duplicate node id
        }
        match n.get("type").and_then(Value::as_str) {
            Some(t) if len16(t) <= MAX_NODE_TYPE_LENGTH => {}
            _ => return false,
        }
        // finite, not merely present: JSON cannot carry NaN, but a graph can
        // also arrive from an MCP tool call one day
        for axis in ["x", "y"] {
            if !n.get(axis).and_then(Value::as_f64).is_some_and(f64::is_finite) {
                return false;
            }
        }
        let Some(config) = n.get("config").and_then(Value::as_object) else { return false };
        // every config value is a string — numbers and booleans are written as
        // "20" / "true", and the interpreter's HashMap<String, String> would
        // refuse to deserialize anything else at run time
        if config.values().any(|v| !v.is_string()) {
            return false;
        }
    }

    for e in edges {
        let Some(e) = e.as_object() else { return false };
        if !e.get("id").is_some_and(Value::is_string) {
            return false;
        }
        if !is_port_ref(e.get("from")) || !is_port_ref(e.get("to")) {
            return false;
        }
        for end in ["from", "to"] {
            let node_id = e[end]["nodeId"].as_str().unwrap_or_default();
            if !node_ids.contains(node_id) {
                return false; // dangling edge
            }
        }
        match e.get("kind").and_then(Value::as_str) {
            Some("flow") | Some("value") => {}
            _ => return false,
        }
    }
    true
}

// --- deep validation --------------------------------------------------------

/// The one GitHub event a PAT is not optional for. Shared with the designer
/// toolbox, which greys the chip out on the same condition — two spellings of
/// this string would drift into a chip you can place but that never polls.
pub const STAR_EVENT_KEY: &str = "event:github-star";
const EVENT_PREFIX: &str = "event:";
const INTEGRATION_PREFIX: &str = "integration:";
const HTTP_REQUEST_KEY: &str = "integration:http-request";

/// One finding: a level + human message, plus the node or edge it concerns (when
/// the check is node/edge-specific — most are). The designer surfaces these live
/// (topbar badge → issues panel → click-to-select, plus a per-node dot); the
/// flat `errors`/`warnings` arrays are derived from them in push order, so every
/// consumer sees the same strings in the same order.
#[derive(Serialize)]
pub struct ValidationIssue {
    pub level: &'static str,
    pub message: String,
    #[serde(rename = "nodeId", skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(rename = "edgeId", skip_serializing_if = "Option::is_none")]
    pub edge_id: Option<String>,
}

#[derive(Serialize)]
pub struct Validation {
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub issues: Vec<ValidationIssue>,
}

impl From<Vec<ValidationIssue>> for Validation {
    fn from(issues: Vec<ValidationIssue>) -> Self {
        let pick = |level| {
            issues.iter().filter(|i| i.level == level).map(|i| i.message.clone()).collect()
        };
        Validation { errors: pick("error"), warnings: pick("warning"), issues }
    }
}

fn finding(
    level: &'static str,
    message: String,
    node_id: Option<&str>,
    edge_id: Option<&str>,
) -> ValidationIssue {
    ValidationIssue {
        level,
        message,
        node_id: node_id.map(str::to_string),
        edge_id: edge_id.map(str::to_string),
    }
}

/// Port of `chipKind`: an mcp server node ("tool"), a skill node, a memory
/// store node, or a chat node ("session") — a value output that feeds only an
/// agent's matching `accepts` port.
fn chip_kind(entry: &CatalogEntry) -> Option<&'static str> {
    if entry.missing {
        return None;
    }
    match entry.category.as_str() {
        "mcp" if entry.tool_name.is_some() => Some("tool"),
        "skill" => Some("skill"),
        "memory" => Some("memory"),
        "session" => Some("session"),
        _ => None,
    }
}

/// Integration and event nodes both fail at run time without their required
/// config; a connected value port overrides the literal, so a port-fed field is
/// fine. One rule, spelled twice in the TypeScript — but the two run at
/// different points in push order, so this is a helper, not a merged pass.
fn missing_required_config(
    nodes: &[Node],
    prefix: &str,
    by_key: &HashMap<String, CatalogEntry>,
    fed_ports: &HashSet<String>,
) -> Vec<ValidationIssue> {
    let mut out = Vec::new();
    for node in nodes {
        if !node.node_type.starts_with(prefix) {
            continue;
        }
        // an unresolvable type is already covered by the unknown-type warning
        let Some(entry) = by_key.get(&node.node_type) else { continue };
        for field in &entry.required_config {
            let blank = node.config.get(field).map_or("", String::as_str).trim().is_empty();
            if blank && !fed_ports.contains(&format!("{}:{field}", node.id)) {
                out.push(finding(
                    "warning",
                    format!("{} \"{}\" has no {field} — the run will fail", entry.label, node.id),
                    Some(&node.id),
                    None,
                ));
            }
        }
    }
    out
}

/// Deep validation for graphs authored without the designer's UI guardrails.
/// Errors are states the canvas cannot produce (bad ports, kind mismatches,
/// duplicate edges, fan-in on a single-edge value input, a chip wired into a
/// mismatched `accepts` port, more than one event node); warnings are
/// legal-but-probably-unintended states.
///
/// `github_linked == Some(false)` means no GitHub PAT is stored, which only
/// `github-star` cares about. `None` leaves star nodes unwarned.
pub fn validate_graph_strict(
    g: &Value,
    by_key: &HashMap<String, CatalogEntry>,
    github_linked: Option<bool>,
) -> Validation {
    let mut issues: Vec<ValidationIssue> = Vec::new();
    // Unreachable in practice: the designer's graph came out of `check_graph`,
    // and `save_graph` puts its own through on the way in. Reusing that gate's
    // message rather than inventing a second vocabulary for the same failure.
    let Ok(graph) = serde_json::from_value::<Graph>(g.clone()) else {
        issues.push(finding("error", "Invalid graph".into(), None, None));
        return issues.into();
    };

    // `byKey` minus the "(deleted)" placeholders. An unresolved type is simply
    // absent from the Rust map — the designer synthesizes a placeholder entry so
    // the node still renders, and `known` rejects it on `missing` anyway, so the
    // two spellings are the same thing here.
    let known = |node: &Node| by_key.get(&node.node_type).filter(|e| !e.missing);

    for node in &graph.nodes {
        if known(node).is_none() {
            issues.push(finding(
                "warning",
                format!(
                    "node \"{}\" has unknown type \"{}\" — it renders as an inert (deleted) placeholder",
                    node.id, node.node_type
                ),
                Some(&node.id),
                None,
            ));
        }
    }

    // entry points are event-category nodes; a workflow must have exactly one —
    // none can never trigger, two+ is disallowed (the designer permits one)
    let event_count =
        graph.nodes.iter().filter(|n| known(n).is_some_and(|e| e.category == "events")).count();
    if event_count == 0 {
        issues.push(finding(
            "warning",
            "no event node — add a 'scheduled to run' block so the workflow can trigger".into(),
            None,
            None,
        ));
    } else if event_count > 1 {
        issues.push(finding(
            "error",
            format!("a workflow may have only one event node, but this graph has {event_count}"),
            None,
            None,
        ));
    }

    // a schedule node with a blank/invalid cron never fires
    for node in &graph.nodes {
        if node.node_type != "schedule" {
            continue;
        }
        let cron = node.config.get("cron").map_or("", String::as_str).trim();
        if cron.is_empty() {
            issues.push(finding(
                "warning",
                format!("schedule node \"{}\" has no cron — it will never fire", node.id),
                Some(&node.id),
                None,
            ));
        } else if !is_valid_cron(&cron.split_whitespace().collect::<Vec<_>>()) {
            issues.push(finding(
                "warning",
                format!(
                    "schedule node \"{}\" has an invalid cron \"{cron}\" — it will never fire",
                    node.id
                ),
                Some(&node.id),
                None,
            ));
        }
    }

    let node_by_id: HashMap<&str, &Node> =
        graph.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut value_in_degree: HashMap<String, u32> = HashMap::new();
    for edge in &graph.edges {
        // DIVERGENCE (docs/open-decisions.md §2.9): the TypeScript asserted both
        // endpoints resolve and threw a TypeError when one did not, so no golden
        // case can arbitrate this. `check_graph` rejects a dangling edge at save
        // time, so skipping it is the branch that cannot be reached.
        let (Some(from_node), Some(to_node)) = (
            node_by_id.get(edge.from.node_id.as_str()).copied(),
            node_by_id.get(edge.to.node_id.as_str()).copied(),
        ) else {
            continue;
        };
        let label = format!(
            "edge \"{}\" ({}.{} → {}.{})",
            edge.id, edge.from.node_id, edge.from.port_id, edge.to.node_id, edge.to.port_id
        );

        if edge.from.node_id == edge.to.node_id {
            issues.push(finding(
                "error",
                format!("{label}: a node cannot connect to itself"),
                None,
                Some(&edge.id),
            ));
            continue;
        }
        let dup_key = format!(
            "{}.{}>{}.{}",
            edge.from.node_id, edge.from.port_id, edge.to.node_id, edge.to.port_id
        );
        if !seen.insert(dup_key) {
            issues.push(finding(
                "error",
                format!("{label}: duplicate edge"),
                None,
                Some(&edge.id),
            ));
            continue;
        }

        // edges anchored on unknown-type nodes can't be port-checked
        // (placeholders have no ports) — the unknown-type warning covers them
        let (Some(from_entry), Some(to_entry)) = (known(from_node), known(to_node)) else {
            continue;
        };
        let Some(from_port) = from_entry.outputs.iter().find(|p| p.id == edge.from.port_id) else {
            issues.push(finding(
                "error",
                format!(
                    "{label}: \"{}\" has no output port \"{}\"",
                    from_node.node_type, edge.from.port_id
                ),
                None,
                Some(&edge.id),
            ));
            continue;
        };
        let Some(to_port) = to_entry.inputs.iter().find(|p| p.id == edge.to.port_id) else {
            issues.push(finding(
                "error",
                format!(
                    "{label}: \"{}\" has no input port \"{}\"",
                    to_node.node_type, edge.to.port_id
                ),
                None,
                Some(&edge.id),
            ));
            continue;
        };
        if from_port.kind != to_port.kind || edge.kind != from_port.kind {
            issues.push(finding(
                "error",
                format!(
                    "{label}: port kinds don't match ({} output → {} input, edge kind \"{}\")",
                    from_port.kind, to_port.kind, edge.kind
                ),
                None,
                Some(&edge.id),
            ));
            continue;
        }
        // grant-chip gating (mirrors canConnect): an accepts port takes only its
        // chip kind (hard error); a chip output wired into an ordinary value
        // input grants nothing (warning — old graphs may carry these)
        let src_chip = chip_kind(from_entry);
        match &to_port.accepts {
            Some(accepts) => {
                if src_chip != Some(accepts.as_str()) {
                    issues.push(finding(
                        "error",
                        format!(
                            "{label}: input \"{}\" accepts only {accepts} grant-chip nodes",
                            to_port.id
                        ),
                        None,
                        Some(&edge.id),
                    ));
                    continue;
                }
            }
            None => {
                if let Some(chip) = src_chip {
                    issues.push(finding(
                        "warning",
                        format!(
                            "{label}: {chip} nodes only grant agents — this edge into an ordinary value input is ignored"
                        ),
                        None,
                        Some(&edge.id),
                    ));
                }
            }
        }
        if to_port.kind == "value" && !to_port.multi {
            let in_key = format!("{}.{}", edge.to.node_id, edge.to.port_id);
            let count = value_in_degree.entry(in_key.clone()).or_insert(0);
            *count += 1;
            // ponytail: `== 2`, not `>= 2` — verbatim from the TypeScript. The
            // third edge into an already-reported input adds no information, so
            // one message per over-subscribed port is the intent, not a bug.
            if *count == 2 {
                issues.push(finding(
                    "error",
                    format!(
                        "input {in_key} has multiple incoming value edges — this value input accepts one edge"
                    ),
                    Some(&edge.to.node_id),
                    Some(&edge.id),
                ));
            }
        }
    }

    // grants are edges from chip nodes into the tools/skills ports; config.model
    // stays a fallback when the model port is unwired
    for node in &graph.nodes {
        if node.node_type != "agent" {
            continue;
        }
        let has_model_edge = graph
            .edges
            .iter()
            .any(|e| e.to.node_id == node.id && e.to.port_id == "model" && e.kind == "value");
        if !has_model_edge
            && node.config.get("model").map_or("", String::as_str).trim().is_empty()
        {
            issues.push(finding(
                "warning",
                format!("agent \"{}\" has no model — the run will fail", node.id),
                Some(&node.id),
                None,
            ));
        }
        let grants = |port: &str| {
            graph.edges.iter().filter(|e| e.to.node_id == node.id && e.to.port_id == port).count()
        };
        for (port, cap, what) in [
            ("tools", agent::MAX_GRANTED_TOOLS, "tool"),
            ("skills", agent::MAX_GRANTED_SKILLS, "skill"),
        ] {
            if grants(port) > cap {
                issues.push(finding(
                    "warning",
                    format!(
                        "agent \"{}\" has more than {cap} {what} grants — extras are dropped at run time",
                        node.id
                    ),
                    Some(&node.id),
                    None,
                ));
            }
        }
    }

    // mcp server nodes: config.exclude prunes the tool grant per node — a
    // malformed value is ignored at run time (all enabled tools granted), and
    // excluded names the server doesn't have are harmless but likely typos
    for node in &graph.nodes {
        let Some(entry) = known(node) else { continue };
        if chip_kind(entry) != Some("tool") {
            continue;
        }
        let Some(exclude) =
            agent::parse_tool_exclusions(node.config.get("exclude").map_or("", String::as_str))
        else {
            issues.push(finding(
                "warning",
                format!(
                    "mcp node \"{}\": exclude is not a JSON array of tool names — ignored, all enabled tools granted",
                    node.id
                ),
                Some(&node.id),
                None,
            ));
            continue;
        };
        for name in exclude {
            if !entry.tools.iter().any(|t| t.name == name) {
                issues.push(finding(
                    "warning",
                    format!(
                        "mcp node \"{}\": excluded tool \"{name}\" doesn't exist on {} — ignored",
                        node.id, entry.label
                    ),
                    Some(&node.id),
                    None,
                ));
            }
        }
    }

    // a connected value port overrides the literal, so a port-fed field is fine
    let fed_ports: HashSet<String> = graph
        .edges
        .iter()
        .filter(|e| e.kind == "value")
        .map(|e| format!("{}:{}", e.to.node_id, e.to.port_id))
        .collect();
    issues.extend(missing_required_config(
        &graph.nodes,
        INTEGRATION_PREFIX,
        by_key,
        &fed_ports,
    ));

    // http request headers must be a JSON object of strings — a literal that
    // isn't (and no port feeding it) fails the send at run time
    for node in &graph.nodes {
        if node.node_type != HTTP_REQUEST_KEY {
            continue;
        }
        let headers = node.config.get("headers").map_or("", String::as_str).trim();
        if headers.is_empty() || fed_ports.contains(&format!("{}:headers", node.id)) {
            continue;
        }
        let ok = serde_json::from_str::<Value>(headers)
            .ok()
            .and_then(|v| v.as_object().map(|o| o.values().all(Value::is_string)))
            .unwrap_or(false);
        if !ok {
            // ponytail: a comma where every sibling message uses an em dash —
            // verbatim from the TypeScript, which `validation.json` pins.
            issues.push(finding(
                "warning",
                format!(
                    "http request \"{}\" headers is not a JSON object of strings, the run will fail",
                    node.id
                ),
                Some(&node.id),
                None,
            ));
        }
    }

    issues.extend(missing_required_config(&graph.nodes, EVENT_PREFIX, by_key, &fed_ports));

    // Only star needs the PAT. Its page-1 stargazers fetch deliberately skips
    // if-none-match, so it cannot 304, and ~120 counted requests/hour overruns
    // GitHub's 60/hr unauthenticated budget — which parks every other watch too.
    // `github::Resource::pollable` is the guard that enforces it.
    if github_linked == Some(false) {
        for node in &graph.nodes {
            if node.node_type != STAR_EVENT_KEY {
                continue;
            }
            let label =
                by_key.get(&node.node_type).map_or(node.node_type.as_str(), |e| e.label.as_str());
            issues.push(finding(
                "warning",
                format!(
                    "{label} \"{}\" needs a GitHub token — without one it is not polled at all; add one in settings",
                    node.id
                ),
                Some(&node.id),
                None,
            ));
        }
    }

    // event config is read statically by the always-on listeners before any run
    // (events.rs), so only variable/string/number sources can feed an event
    // config port — a dynamic source silently resolves to blank
    for edge in &graph.edges {
        if edge.kind != "value" {
            continue;
        }
        let Some(to_node) = node_by_id.get(edge.to.node_id.as_str()).copied() else { continue };
        if !to_node.node_type.starts_with(EVENT_PREFIX)
            || !by_key.contains_key(&to_node.node_type)
        {
            continue;
        }
        let Some(src) = node_by_id.get(edge.from.node_id.as_str()).copied() else { continue };
        // unknown-type warning already covers an unresolvable source
        let Some(src_entry) = known(src) else { continue };
        if src_entry.category != "variable"
            && !STATIC_VALUE_TYPES.contains(&src.node_type.as_str())
        {
            // ponytail: "a {label}" with no article agreement — "is fed by a
            // agent node" — verbatim from the TypeScript.
            issues.push(finding(
                "warning",
                format!(
                    "event node \"{}\": port \"{}\" is fed by a {} node — event config resolves before any run, so only variable/string/number sources apply; this edge is ignored",
                    to_node.id, edge.to.port_id, src_entry.label
                ),
                Some(&to_node.id),
                Some(&edge.id),
            ));
        }
    }

    issues.into()
}

// --- layout -----------------------------------------------------------------

const COL_W: f64 = 264.0;
const ROW_H: f64 = 168.0;

/// Places a graph whose author could not know where anything goes — Saturn's
/// `save_graph` tool, which tells the model to omit `x`/`y`. Column = longest
/// path over all edges, so every node sits right of everything feeding it; row =
/// its index within that column.
///
/// **All-or-nothing:** a graph already carrying every coordinate is trusted
/// verbatim, so `get_workflow` → edit → `save_graph` never scrambles an
/// arrangement the user dragged into place.
///
// ponytail: fixed 264×168 spacing, no node-size measurement. geometry.ts's
// nodeWidth/nodeHeight pull in text metrics, chip sizes and the agent's
// port-count width — porting them makes Rust a third source of truth for node
// metrics, which CLAUDE.md gives to geometry.ts alone. Tall nodes can overlap;
// the user drags them. Port the metrics only if it reads badly.
pub fn fill_coords(g: &mut Value) {
    let Some(nodes) = g.get("nodes").and_then(Value::as_array) else { return };
    let placed = |n: &Value, k: &str| n.get(k).and_then(Value::as_f64).is_some_and(f64::is_finite);
    if nodes.iter().all(|n| placed(n, "x") && placed(n, "y")) {
        return;
    }

    let mut preds: HashMap<String, Vec<String>> = HashMap::new();
    for e in g.get("edges").and_then(Value::as_array).unwrap_or(&Vec::new()) {
        let (from, to) = (&e["from"]["nodeId"], &e["to"]["nodeId"]);
        if let (Some(from), Some(to)) = (from.as_str(), to.as_str()) {
            preds.entry(to.to_string()).or_default().push(from.to_string());
        }
    }

    let ids: Vec<String> = nodes
        .iter()
        .map(|n| n["id"].as_str().unwrap_or_default().to_string())
        .collect();
    let (mut memo, mut walking, mut rows) = (HashMap::new(), HashSet::new(), HashMap::new());
    let coords: Vec<(f64, f64)> = ids
        .iter()
        .map(|id| {
            let col = depth_of(id, &preds, &mut memo, &mut walking);
            let row = rows.entry(col).or_insert(0.0);
            *row += 1.0;
            (col as f64 * COL_W, (*row - 1.0) * ROW_H)
        })
        .collect();

    for (n, (x, y)) in g["nodes"].as_array_mut().into_iter().flatten().zip(coords) {
        n["x"] = x.into();
        n["y"] = y.into();
    }
}

/// Longest path to `id`, memoized. A flow cycle breaks even at 0 — the
/// interpreter is what reports it; layout only has to terminate.
fn depth_of(
    id: &str,
    preds: &HashMap<String, Vec<String>>,
    memo: &mut HashMap<String, usize>,
    walking: &mut HashSet<String>,
) -> usize {
    if let Some(d) = memo.get(id) {
        return *d;
    }
    if !walking.insert(id.to_string()) {
        return 0;
    }
    let d = preds
        .get(id)
        .map(|ps| ps.iter().map(|p| depth_of(p, preds, memo, walking) + 1).max().unwrap_or(0))
        .unwrap_or(0);
    walking.remove(id);
    memo.insert(id.to_string(), d);
    d
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interpreter::CATALOG;
    use serde_json::json;
    use std::fs;

    fn graph() -> Value {
        json!({
            "nodes": [
                { "id": "a", "type": "schedule", "x": 0, "y": 0, "config": { "cron": "* * * * *" } },
                { "id": "b", "type": "print", "x": 10.5, "y": -20.0, "config": {} },
            ],
            "edges": [
                { "id": "e1", "from": { "nodeId": "a", "portId": "out" },
                  "to": { "nodeId": "b", "portId": "in" }, "kind": "flow" },
            ],
        })
    }

    #[test]
    fn accepts_a_designer_graph() {
        assert!(is_workflow_graph(&graph()));
        assert!(is_workflow_graph(&json!({ "nodes": [], "edges": [] })));
    }

    /// Every rejection rule, one mutation each. A shape guard that silently
    /// stops enforcing one of these lets a graph into the database that the
    /// interpreter then fails to deserialize — the workflow is dead and the
    /// only symptom is "workflow graph is malformed" at run time.
    #[test]
    fn rejects_each_broken_shape() {
        let cases: Vec<(&str, Value)> = vec![
            ("not an object", json!([])),
            ("no nodes", json!({ "edges": [] })),
            ("no edges", json!({ "nodes": [] })),
            ("nodes not an array", json!({ "nodes": {}, "edges": [] })),
            ("node not an object", json!({ "nodes": ["x"], "edges": [] })),
            (
                "node id missing",
                json!({ "nodes": [{ "type": "print", "x": 0, "y": 0, "config": {} }], "edges": [] }),
            ),
            (
                "duplicate node id",
                json!({ "nodes": [
                    { "id": "a", "type": "print", "x": 0, "y": 0, "config": {} },
                    { "id": "a", "type": "print", "x": 1, "y": 1, "config": {} },
                ], "edges": [] }),
            ),
            (
                "type too long",
                json!({ "nodes": [
                    { "id": "a", "type": "x".repeat(MAX_NODE_TYPE_LENGTH + 1), "x": 0, "y": 0, "config": {} },
                ], "edges": [] }),
            ),
            (
                "x not a number",
                json!({ "nodes": [{ "id": "a", "type": "print", "x": "0", "y": 0, "config": {} }], "edges": [] }),
            ),
            (
                "config value not a string",
                json!({ "nodes": [
                    { "id": "a", "type": "print", "x": 0, "y": 0, "config": { "n": 20 } },
                ], "edges": [] }),
            ),
            (
                "config not an object",
                json!({ "nodes": [{ "id": "a", "type": "print", "x": 0, "y": 0, "config": [] }], "edges": [] }),
            ),
        ];
        for (why, g) in cases {
            assert!(!is_workflow_graph(&g), "accepted a graph it must reject: {why}");
        }

        // edge rules, mutated off the good graph so only one thing is wrong
        let edge_cases: Vec<(&str, Value)> = vec![
            ("edge id missing", json!({ "from": { "nodeId": "a", "portId": "out" },
                                        "to": { "nodeId": "b", "portId": "in" }, "kind": "flow" })),
            ("from not a port ref", json!({ "id": "e", "from": "a",
                                            "to": { "nodeId": "b", "portId": "in" }, "kind": "flow" })),
            ("portId missing", json!({ "id": "e", "from": { "nodeId": "a" },
                                       "to": { "nodeId": "b", "portId": "in" }, "kind": "flow" })),
            ("dangling from", json!({ "id": "e", "from": { "nodeId": "ghost", "portId": "out" },
                                      "to": { "nodeId": "b", "portId": "in" }, "kind": "flow" })),
            ("dangling to", json!({ "id": "e", "from": { "nodeId": "a", "portId": "out" },
                                    "to": { "nodeId": "ghost", "portId": "in" }, "kind": "flow" })),
            ("unknown kind", json!({ "id": "e", "from": { "nodeId": "a", "portId": "out" },
                                     "to": { "nodeId": "b", "portId": "in" }, "kind": "grant" })),
        ];
        for (why, edge) in edge_cases {
            let mut g = graph();
            g["edges"] = json!([edge]);
            assert!(!is_workflow_graph(&g), "accepted an edge it must reject: {why}");
        }
    }

    /// The 30 cases in `fixtures/validation.json` were captured from the live
    /// TypeScript `validateGraphStrict` before it was deleted, so this is the
    /// only thing standing between the port and a silent behaviour change. The
    /// whole `Validation` is compared — flat arrays, issue order, and each
    /// issue's node/edge ref.
    #[test]
    fn validation_golden() {
        let raw = fs::read_to_string("../fixtures/validation.json").expect("fixtures/validation.json");
        let cases: Vec<Value> = serde_json::from_str(&raw).unwrap();
        assert_eq!(cases.len(), 30, "the oracle lost cases");

        for case in &cases {
            let name = case["name"].as_str().unwrap();
            // byKey exactly as the designer builds it: the static catalog with
            // the user's registry entries over it. The designer also synthesizes
            // a "(deleted)" placeholder per unresolved type; the validator reads
            // those through `known`, which rejects them, so an absent key and a
            // placeholder are the same input here.
            let mut by_key: HashMap<String, CatalogEntry> =
                CATALOG.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            for e in case["entries"].as_array().unwrap_or(&Vec::new()) {
                let entry: CatalogEntry = serde_json::from_value(e.clone()).unwrap();
                by_key.insert(entry.key.clone(), entry);
            }
            let got = validate_graph_strict(&case["graph"], &by_key, case["githubLinked"].as_bool());
            assert_eq!(
                serde_json::to_value(&got).unwrap(),
                case["expected"],
                "validation case {name}"
            );
        }
    }

    #[test]
    fn fill_coords_lays_out_only_an_unplaced_graph() {
        let mut g = json!({
            "nodes": [
                { "id": "c", "type": "print", "config": {} },
                { "id": "a", "type": "run", "config": {} },
                { "id": "b", "type": "string", "config": {} },
            ],
            "edges": [
                { "id": "e1", "from": { "nodeId": "a", "portId": "out" },
                  "to": { "nodeId": "c", "portId": "in" }, "kind": "flow" },
                { "id": "e2", "from": { "nodeId": "b", "portId": "out" },
                  "to": { "nodeId": "c", "portId": "message" }, "kind": "value" },
            ],
        });
        fill_coords(&mut g);
        // a and b are roots (column 0, stacked); c is downstream of both
        let at = |i: usize| json!([g["nodes"][i]["x"], g["nodes"][i]["y"]]);
        assert_eq!(at(1), json!([0.0, 0.0]));
        assert_eq!(at(2), json!([0.0, 168.0]));
        assert_eq!(at(0), json!([264.0, 0.0]));

        // all-or-nothing: a fully placed graph is trusted verbatim
        let mut placed = g.clone();
        placed["nodes"][0]["x"] = json!(999.0);
        let before = placed.clone();
        fill_coords(&mut placed);
        assert_eq!(placed, before);

        // a cycle terminates rather than recursing forever
        let mut cyclic = json!({
            "nodes": [{ "id": "a", "type": "print", "config": {} },
                      { "id": "b", "type": "print", "config": {} }],
            "edges": [
                { "id": "e1", "from": { "nodeId": "a", "portId": "out" },
                  "to": { "nodeId": "b", "portId": "in" }, "kind": "flow" },
                { "id": "e2", "from": { "nodeId": "b", "portId": "out" },
                  "to": { "nodeId": "a", "portId": "in" }, "kind": "flow" },
            ],
        });
        fill_coords(&mut cyclic);
        assert!(cyclic["nodes"][0]["x"].is_number());
    }
}
