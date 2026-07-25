//! Port of lib/interpreter.ts — the graph walk. Flow-edge traversal, per-step
//! memoized value resolution, per-chain visited-set cycle detection, MAX_STEPS.
//!
//! No hook trait: the TypeScript routed every side effect through RunHooks
//! because the same interpreter ran in the designer (server actions) and on the
//! server (direct calls). Here there is one process and one implementation, so
//! effects are plain function calls. What varies is where console lines go (the
//! `Sender<ConsoleLine>`) and, for `run_inner` only, the integration sender —
//! the golden-fixture oracle in `interpreter/fixtures.rs` stubs it exactly as
//! `fixtures/run.mjs` does, which is what makes this port checkable at all.
//!
//! The walk is SYNCHRONOUS. It recurses (fan-out today, loop bodies and agent
//! turns in Phase C), and async recursion in Rust means Box::pin at every
//! nesting point for no benefit: a run owns its own thread anyway, and the one
//! blocking call (http::send) is a blocking reqwest client that must NOT be
//! constructed on a runtime worker thread. See runner::execute_run.
//!
//! Phase B implements three node types: schedule (an event entry point),
//! integration:http-request, print. Every other *catalogued* type aborts the run
//! naming itself — never a silent no-op. A type that is not in the catalog at
//! all is a different thing (a graph from a newer build, a deleted registry
//! chip): the TypeScript warns and walks on, and so does this.

use std::collections::{HashMap, HashSet};
use std::sync::mpsc::Sender;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

// total work cap — real flow cycles are caught exactly (per-chain visited set),
// so this only stops pathological-but-legal graphs (huge nested loops)
const MAX_STEPS: u32 = 10_000;
// integration sends budget per run — keep a hot loop off someone's API
const MAX_INTEGRATION_CALLS: u32 = 20;
// long results would drown the console
const MAX_RESULT_CHARS: usize = 2000;

// --- catalog ---------------------------------------------------------------

#[derive(Deserialize)]
pub struct Port {
    pub id: String,
    pub kind: String,
}

#[derive(Deserialize)]
pub struct ConfigField {
    pub id: String,
}

/// Mirrors CatalogEntry from lib/workflow.ts, minus the fields that exist only
/// for rendering (emoji, logoDomain, group, section, …). Unknown JSON fields are
/// ignored by serde, so the whole file deserializes; Phase C adds fields as the
/// node types that need them land.
#[derive(Deserialize)]
pub struct CatalogEntry {
    pub key: String,
    pub category: String,
    pub label: String,
    pub outputs: Vec<Port>,
    #[serde(default)]
    pub config: Vec<ConfigField>,
}

/// The static catalog, baked into the binary. A malformed catalog.json is a
/// build-time authoring error, so panicking on first use is the honest failure.
pub static CATALOG: LazyLock<HashMap<String, CatalogEntry>> = LazyLock::new(|| {
    let entries: Vec<CatalogEntry> = serde_json::from_str(include_str!("../../catalog.json"))
        .expect("catalog.json is malformed");
    entries.into_iter().map(|e| (e.key.clone(), e)).collect()
});

// --- graph -----------------------------------------------------------------

#[derive(Deserialize)]
pub struct Node {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    #[serde(default)]
    pub config: HashMap<String, String>,
}

#[derive(Deserialize)]
pub struct EdgeEnd {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "portId")]
    pub port_id: String,
}

#[derive(Deserialize)]
pub struct Edge {
    pub from: EdgeEnd,
    pub to: EdgeEnd,
    pub kind: String,
}

#[derive(Deserialize)]
pub struct Graph {
    #[serde(default)]
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub edges: Vec<Edge>,
}

// --- console ---------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Print,
    Info,
    Warn,
    Error,
    Image,
}

#[derive(Clone, Serialize)]
pub struct ConsoleLine {
    pub kind: Kind,
    pub text: String,
}

/// JS `s.slice(0, n)` when `s` is longer than `n` UTF-16 units, else None. Every
/// cap in the TypeScript is a `.length` cap, and `.length` counts UTF-16 units —
/// a byte- or char-indexed port cuts somewhere else and diverges from the golden
/// fixtures. A lone surrogate at the cut becomes U+FFFD here (Rust strings
/// cannot hold one); that is the single unavoidable difference.
pub fn utf16_prefix(s: &str, n: usize) -> Option<String> {
    if s.len() <= n {
        return None; // UTF-16 units are never more than UTF-8 bytes
    }
    let units: Vec<u16> = s.encode_utf16().collect();
    if units.len() <= n {
        return None;
    }
    Some(String::from_utf16_lossy(&units[..n]))
}

fn truncate(s: &str) -> String {
    match utf16_prefix(s, MAX_RESULT_CHARS) {
        Some(cut) => format!("{cut}… (truncated)"),
        None => s.to_string(),
    }
}

// --- the walk --------------------------------------------------------------

/// Emitted after the error line is already on the console; unwinds to run_workflow.
struct Abort;

/// Per-flow-step evaluation state: the memo (a diamond of value edges would
/// re-evaluate upstream ports exponentially and repeat every warn) and the
/// value-cycle stack. Local to each step so fan-out branches cannot clobber
/// each other.
#[derive(Default)]
struct EvalCtx {
    memo: HashMap<String, String>,
    stack: HashSet<String>,
}

struct Run<'a> {
    graph: &'a Graph,
    tx: &'a Sender<ConsoleLine>,
    nodes: HashMap<&'a str, &'a Node>,
    /// trigger payload per event node, read off its `payload` port
    event_payloads: Option<&'a HashMap<String, String>>,
    /// the one injected effect: the golden fixtures stub it (fixtures/run.mjs
    /// `callIntegration`), production sends for real
    send: fn(&HashMap<String, String>) -> Result<String, String>,
    steps: u32,
    integration_calls: u32,
    /// "nodeId:portId" -> output, for nodes whose value ports are only readable
    /// after their flow step ran (the http node's `response`).
    results: HashMap<String, String>,
    /// every value computed on every output port, in evaluation order — the
    /// designer's extract-path picker samples these, and it is the half of the
    /// golden fixtures that pins evaluation order and the memo
    values: Vec<(String, String, String)>,
}

impl<'a> Run<'a> {
    fn emit(&self, kind: Kind, text: String) {
        // a dropped receiver means the run is being torn down; the walk still
        // unwinds through its normal paths
        let _ = self.tx.send(ConsoleLine { kind, text });
    }

    fn warn(&self, text: String) {
        self.emit(Kind::Warn, text);
    }

    fn fail(&self, text: String) -> Abort {
        self.emit(Kind::Error, text);
        Abort
    }

    fn label(&self, node: &Node) -> String {
        CATALOG
            .get(&node.node_type)
            .map(|e| e.label.clone())
            .unwrap_or_else(|| node.node_type.clone())
    }

    fn unimplemented(&self, node: &Node) -> Abort {
        self.fail(format!(
            "node type \"{}\" is not implemented yet",
            node.node_type
        ))
    }

    /// flow outputs may fan out — every edge's target, in graph edge order
    fn follow_flow_all(&self, node_id: &str, port_id: &str) -> Vec<&'a Node> {
        self.graph
            .edges
            .iter()
            .filter(|e| e.kind == "flow" && e.from.node_id == node_id && e.from.port_id == port_id)
            .filter_map(|e| self.nodes.get(e.to.node_id.as_str()).copied())
            .collect()
    }

    fn incoming_value_edge(&self, node_id: &str, port_id: &str) -> Option<&'a Edge> {
        self.graph
            .edges
            .iter()
            .find(|e| e.kind == "value" && e.to.node_id == node_id && e.to.port_id == port_id)
    }

    fn eval_input(&mut self, node: &Node, port_id: &str, ctx: &mut EvalCtx) -> Result<String, Abort> {
        let Some(edge) = self.incoming_value_edge(&node.id, port_id) else {
            self.warn(format!(
                "{}: input \"{port_id}\" not connected — using \"\"",
                self.label(node)
            ));
            return Ok(String::new());
        };
        let (from_node, from_port) = (edge.from.node_id.clone(), edge.from.port_id.clone());
        self.eval_output(&from_node, &from_port, ctx)
    }

    fn eval_output(&mut self, node_id: &str, port_id: &str, ctx: &mut EvalCtx) -> Result<String, Abort> {
        let key = format!("{node_id}:{port_id}");
        if let Some(hit) = ctx.memo.get(&key) {
            return Ok(hit.clone());
        }
        let value = self.compute_output(node_id, port_id, &key, ctx)?;
        ctx.memo.insert(key, value.clone());
        self.values
            .push((node_id.to_string(), port_id.to_string(), value.clone()));
        Ok(value)
    }

    fn compute_output(
        &mut self,
        node_id: &str,
        port_id: &str,
        key: &str,
        ctx: &mut EvalCtx,
    ) -> Result<String, Abort> {
        let Some(node) = self.nodes.get(node_id).copied() else {
            return Ok(String::new());
        };
        if ctx.stack.contains(key) {
            return Err(self.fail("value cycle detected".into()));
        }
        ctx.stack.insert(key.to_string());
        let out = self.compute_uncycled(node, port_id, key);
        ctx.stack.remove(key);
        out
    }

    fn compute_uncycled(&mut self, node: &'a Node, port_id: &str, key: &str) -> Result<String, Abort> {
        // a node type that is not in the catalog at all (a deleted registry
        // entry, a graph from a newer build) is not an error — it evaluates to ""
        let Some(entry) = CATALOG.get(&node.node_type) else {
            self.warn(format!(
                "cannot evaluate output \"{port_id}\" of {} — using \"\"",
                self.label(node)
            ));
            return Ok(String::new());
        };
        match entry.category.as_str() {
            // event nodes carry the trigger payload on their sole value output
            "events" => Ok(self
                .event_payloads
                .and_then(|m| m.get(&node.id))
                .cloned()
                .unwrap_or_default()),
            // read-style integration actions stash their result under the
            // declared value output when their flow step runs
            "integration" => match self.results.get(key) {
                Some(v) => Ok(v.clone()),
                None => {
                    self.warn(format!(
                        "{}: \"{port_id}\" read before the node ran — using \"\"",
                        self.label(node)
                    ));
                    Ok(String::new())
                }
            },
            _ => Err(self.unimplemented(node)),
        }
    }

    /// dispatch a flow output: nothing, one chain, or a fan-out
    fn exec_from(&mut self, node_id: &str, port_id: &str, visited: &HashSet<String>) -> Result<(), Abort> {
        let targets = self.follow_flow_all(node_id, port_id);
        match targets.len() {
            0 => Ok(()),
            1 => self.exec_chain(targets[0], visited.clone()),
            _ => self.fan_out(targets, visited),
        }
    }

    /// Each branch gets a copy of the chain's visited set: a cycle back through
    /// the fan-out is still caught, but branches reconverging on a shared
    /// downstream node are not a false cycle. Branches run sequentially in edge
    /// order — that is what the TypeScript's Promise.allSettled over
    /// synchronous-until-first-await chains actually did, and the golden
    /// fixtures pin that ordering.
    fn fan_out(&mut self, targets: Vec<&'a Node>, visited: &HashSet<String>) -> Result<(), Abort> {
        for target in targets {
            self.exec_chain(target, visited.clone())?;
        }
        Ok(())
    }

    fn exec_chain(&mut self, start: &'a Node, mut visited: HashSet<String>) -> Result<(), Abort> {
        let mut current = Some(start);
        while let Some(node) = current {
            if visited.contains(&node.id) {
                let label = self.label(node);
                return Err(self.fail(format!("flow cycle detected at \"{label}\"")));
            }
            visited.insert(node.id.clone());
            self.steps += 1;
            if self.steps > MAX_STEPS {
                return Err(self.fail(format!("step limit ({MAX_STEPS}) exceeded")));
            }
            let mut ctx = EvalCtx::default();

            let next: Option<&str> = match node.node_type.as_str() {
                "print" => {
                    self.exec_print(node, &mut ctx)?;
                    Some("out")
                }
                _ => match CATALOG.get(&node.node_type).map(|e| e.category.as_str()) {
                    // event nodes are entry points; the normal path runs their
                    // "out" via exec_from, so this only fires when a flow cycle
                    // re-enters one
                    Some("events") => Some("out"),
                    Some("integration") => {
                        self.exec_integration(node, &mut ctx)?;
                        Some("out")
                    }
                    // uncatalogued type: nothing to run and no flow semantics to
                    // guess at, so the chain ends — the run itself is fine
                    None => {
                        self.warn(format!("\"{}\" skipped", self.label(node)));
                        None
                    }
                    _ => return Err(self.unimplemented(node)),
                },
            };

            let Some(next) = next else { break };
            let targets = self.follow_flow_all(&node.id, next);
            if targets.len() > 1 {
                // a fan-out replaces the single-next continuation
                self.fan_out(targets, &visited)?;
                current = None;
            } else {
                current = targets.into_iter().next();
            }
        }
        Ok(())
    }

    fn exec_print(&mut self, node: &Node, ctx: &mut EvalCtx) -> Result<(), Abort> {
        let msg = node.config.get("message").cloned().unwrap_or_default();
        // a connected "message" edge overrides the literal; graphs saved before
        // the port/field merge wired a "value" port instead — honor it with the
        // old prefix-concat semantics
        let overridden = self.incoming_value_edge(&node.id, "message").is_some();
        let legacy = !overridden && self.incoming_value_edge(&node.id, "value").is_some();
        let value = if overridden {
            self.eval_input(node, "message", ctx)?
        } else if legacy {
            self.eval_input(node, "value", ctx)?
        } else {
            String::new()
        };
        if (overridden || legacy) && value.starts_with("data:image/") {
            if legacy && !msg.is_empty() {
                self.emit(Kind::Print, msg);
            }
            self.emit(Kind::Image, value);
        } else if legacy {
            let text = if msg.is_empty() { value } else { format!("{msg} {value}") };
            self.emit(Kind::Print, text);
        } else {
            self.emit(Kind::Print, if overridden { value } else { msg });
        }
        Ok(())
    }

    fn exec_integration(&mut self, node: &'a Node, ctx: &mut EvalCtx) -> Result<(), Abort> {
        self.integration_calls += 1;
        if self.integration_calls > MAX_INTEGRATION_CALLS {
            return Err(self.fail(format!(
                "integration call limit ({MAX_INTEGRATION_CALLS}) exceeded for one run"
            )));
        }
        let entry = CATALOG.get(&node.node_type).expect("category matched above");

        // every config field has a same-id value port that overrides the literal
        // when connected; iterate the catalog fields (not node.config) so stale
        // saved keys cannot invent ports. message stays a separate param.
        let mut config = node.config.clone();
        for field in &entry.config {
            if field.id != "message" && self.incoming_value_edge(&node.id, &field.id).is_some() {
                let value = self.eval_input(node, &field.id, ctx)?;
                config.insert(field.id.clone(), value);
            }
        }
        // the TypeScript also resolves a `message` param here; no integration in
        // this slice takes one (http-request has no message port or field), so
        // Phase C adds it back with the senders that need it.

        // read-style actions declare a value output; the sender's result is
        // stashed under it
        let value_out = entry.outputs.iter().find(|o| o.kind == "value").map(|o| o.id.clone());
        self.emit(
            Kind::Info,
            format!(
                "{} {}…",
                if value_out.is_some() { "running" } else { "sending via" },
                entry.label
            ),
        );

        let provider = node
            .node_type
            .strip_prefix("integration:")
            .unwrap_or(&node.node_type);
        if provider != "http-request" {
            return Err(self.unimplemented(node));
        }
        let text = match (self.send)(&config) {
            Ok(text) => text,
            Err(err) => return Err(self.fail(format!("{}: {err}", entry.label))),
        };
        self.emit(
            Kind::Info,
            truncate(&format!(
                "{} → {}",
                entry.label,
                if text.is_empty() { "(empty)" } else { &text }
            )),
        );
        if let Some(port) = value_out {
            self.results.insert(format!("{}:{port}", node.id), text.clone());
            self.values.push((node.id.clone(), port, text));
        }
        Ok(())
    }
}

/// Walks `graph`, streaming console lines into `tx` as they are produced.
/// `entry_node_ids` is what a cron tick passes (the schedule nodes matching this
/// minute); None fires every event-category node, which is what a manual/test
/// run does.
pub fn run_workflow(graph: &Graph, entry_node_ids: Option<&[String]>, tx: &Sender<ConsoleLine>) {
    // no trigger carries a payload yet (cron and manual are the only ones), and
    // the real sender is the only effect production injects
    run_inner(graph, entry_node_ids, None, tx, crate::http::send);
}

/// `run_workflow` plus the two seams the golden-fixture oracle drives: seeded
/// event payloads and a stubbed integration sender. Returns the value stream
/// (nodeId, portId, text) in evaluation order.
fn run_inner(
    graph: &Graph,
    entry_node_ids: Option<&[String]>,
    event_payloads: Option<&HashMap<String, String>>,
    tx: &Sender<ConsoleLine>,
    send: fn(&HashMap<String, String>) -> Result<String, String>,
) -> Vec<(String, String, String)> {
    let mut run = Run {
        graph,
        tx,
        nodes: graph.nodes.iter().map(|n| (n.id.as_str(), n)).collect(),
        event_payloads,
        send,
        steps: 0,
        integration_calls: 0,
        results: HashMap::new(),
        values: Vec::new(),
    };

    let entries: Vec<&Node> = match entry_node_ids {
        Some(ids) => ids
            .iter()
            .filter_map(|id| run.nodes.get(id.as_str()).copied())
            .collect(),
        None => graph
            .nodes
            .iter()
            .filter(|n| CATALOG.get(&n.node_type).is_some_and(|e| e.category == "events"))
            .collect(),
    };
    if entries.is_empty() {
        run.emit(
            Kind::Error,
            "no event node — add a 'scheduled to run' block from the toolbox".into(),
        );
        return run.values;
    }

    run.emit(Kind::Info, "▶ run started".into());
    // event nodes are independent entry points; the first abort stops the run
    for entry in entries {
        if run.exec_from(&entry.id, "out", &HashSet::new()).is_err() {
            run.emit(Kind::Error, "run aborted".into());
            return run.values;
        }
    }
    run.emit(Kind::Info, format!("run finished ({} steps)", run.steps));
    run.values
}

#[cfg(test)]
mod fixtures;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn drain(graph: serde_json::Value) -> Vec<(Kind, String)> {
        let graph: Graph = serde_json::from_value(graph).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        run_workflow(&graph, None, &tx);
        drop(tx);
        rx.into_iter().map(|l| (l.kind, l.text)).collect()
    }

    fn node(id: &str, ty: &str, config: serde_json::Value) -> serde_json::Value {
        json!({ "id": id, "type": ty, "x": 0, "y": 0, "config": config })
    }

    fn edge(from: (&str, &str), to: (&str, &str), kind: &str) -> serde_json::Value {
        json!({
            "id": format!("{}{}-{}{}", from.0, from.1, to.0, to.1),
            "from": { "nodeId": from.0, "portId": from.1 },
            "to": { "nodeId": to.0, "portId": to.1 },
            "kind": kind,
        })
    }

    /// The catalog is a build artifact of another file — a parse failure or a
    /// renamed key must fail here, not at first run.
    #[test]
    fn catalog_loads() {
        assert!(CATALOG.len() >= 30, "catalog is suspiciously small");
        assert_eq!(CATALOG["schedule"].category, "events");
        assert_eq!(CATALOG["print"].label, "print");
        let http = &CATALOG["integration:http-request"];
        assert_eq!(http.category, "integration");
        assert!(http.outputs.iter().any(|o| o.id == "response" && o.kind == "value"));
        assert!(http.config.iter().any(|f| f.id == "url"));
    }

    #[test]
    fn walks_flow_edges_and_caps_steps() {
        // schedule -> print -> print, then a cycle back: the visited set catches
        // it before MAX_STEPS ever could
        let lines = drain(json!({
            "nodes": [
                node("s", "schedule", json!({ "cron": "* * * * *" })),
                node("a", "print", json!({ "message": "one" })),
                node("b", "print", json!({ "message": "two" })),
            ],
            "edges": [
                edge(("s", "out"), ("a", "in"), "flow"),
                edge(("a", "out"), ("b", "in"), "flow"),
                edge(("b", "out"), ("a", "in"), "flow"),
            ],
        }));
        let texts: Vec<&str> = lines.iter().map(|(_, t)| t.as_str()).collect();
        assert_eq!(
            texts,
            [
                "▶ run started",
                "one",
                "two",
                "flow cycle detected at \"print\"",
                "run aborted"
            ]
        );
    }

    #[test]
    fn unimplemented_node_aborts_naming_itself() {
        let lines = drain(json!({
            "nodes": [
                node("s", "schedule", json!({})),
                node("i", "if", json!({ "operator": "==" })),
            ],
            "edges": [edge(("s", "out"), ("i", "in"), "flow")],
        }));
        assert!(
            lines.iter().any(|(k, t)| *k == Kind::Error
                && t == "node type \"if\" is not implemented yet"),
            "{lines:?}",
        );
    }

    #[test]
    fn no_event_node() {
        let lines = drain(json!({ "nodes": [node("a", "print", json!({}))], "edges": [] }));
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].0, Kind::Error);
        assert!(lines[0].1.starts_with("no event node"));
    }

    /// Value resolution: an unconnected input warns and yields "", and the memo
    /// means a diamond evaluates its shared source once (one warn, not two).
    #[test]
    fn unconnected_input_warns_once_per_step() {
        let lines = drain(json!({
            "nodes": [
                node("s", "schedule", json!({})),
                node("h", "integration:http-request", json!({ "url": "" })),
                node("p", "print", json!({})),
            ],
            "edges": [
                edge(("s", "out"), ("p", "in"), "flow"),
                // both print ports read the same unrun http node output
                edge(("h", "response"), ("p", "message"), "value"),
            ],
        }));
        let warns: Vec<&str> = lines
            .iter()
            .filter(|(k, _)| *k == Kind::Warn)
            .map(|(_, t)| t.as_str())
            .collect();
        assert_eq!(warns, ["http request: \"response\" read before the node ran — using \"\""]);
    }

    #[test]
    fn utf16_prefix_cuts_on_code_units() {
        assert_eq!(utf16_prefix("hello", 10), None);
        assert_eq!(utf16_prefix("hello", 3).unwrap(), "hel");
        // "é" is 2 UTF-8 bytes but 1 UTF-16 unit — a byte-indexed cut is wrong
        assert_eq!(utf16_prefix("ééé", 2).unwrap(), "éé");
        // an astral char is 2 UTF-16 units; cutting between them yields U+FFFD
        assert_eq!(utf16_prefix("🚀x", 1).unwrap(), "\u{fffd}");
    }
}
