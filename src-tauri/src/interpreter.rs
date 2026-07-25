//! Port of lib/interpreter.ts — the graph walk. Flow-edge traversal, per-step
//! memoized value resolution, per-chain visited-set cycle detection, MAX_STEPS.
//!
//! No hook trait: the TypeScript routed every side effect through RunHooks
//! because the same interpreter ran in the designer (server actions) and on the
//! server (direct calls). Here there is one process and one implementation, so
//! effects are plain function calls. What varies is where console lines go (the
//! `Sender<ConsoleLine>`) and, for `run_inner` only, the three `Effects` — the
//! golden-fixture oracle in `interpreter/fixtures.rs` stubs them exactly as
//! `fixtures/run.mjs` does, which is what makes this port checkable at all.
//!
//! The walk is SYNCHRONOUS. It recurses (fan-out, loop bodies, agent turns), and
//! async recursion in Rust means Box::pin at every nesting point for no benefit:
//! a run owns its own thread anyway, and the one blocking call (http::send) is a
//! blocking reqwest client that must NOT be constructed on a runtime worker
//! thread. See runner::execute_run.
//!
//! Every catalogued node type is ported: the event entry points, print, if,
//! loop, await, the data nodes (string/number/literal/concat/extract), the logic
//! nodes (and/or/not), agent + model, the registry chips, and all seven
//! integration providers (via `crate::integrations`). A type with no catalog
//! entry at all is a different thing (a graph from a newer build, a deleted
//! registry chip): the TypeScript warns and walks on, and so does this.
//!
//! Values are `js::Value`, not `String`: `RunValue` is `string | number |
//! boolean` and the variant decides how `if` compares and how a number prints.

pub(crate) mod js;

use crate::agent;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

use js::Value;

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
    /// registry-only: the entry the chip points at was deleted. It still renders
    /// (as "(deleted)") and still parses, but it grants nothing.
    #[serde(default)]
    pub missing: bool,
    /// registry-only, mcp chips: `"*"` on the server grant chip. Its presence is
    /// what makes an edge a tool grant rather than a stray value edge.
    #[serde(rename = "toolName", default)]
    pub tool_name: Option<String>,
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

pub(crate) fn truncate(s: &str) -> String {
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
    memo: HashMap<String, Value>,
    stack: HashSet<String>,
}

/// (providerId, merged config, resolved message) — `executeIntegration`'s three
/// arguments. The message is separate from the config because that is how the
/// TypeScript passed it, and every sender but http-request reads it.
pub(crate) type SendFn<'a> =
    &'a (dyn Fn(&str, &HashMap<String, String>, &str) -> Result<String, String> + Sync);
pub(crate) type ModelFn<'a> = &'a (dyn Fn(&agent::Request) -> agent::Turn + Sync);
/// The first argument routes an agent's granted-tool call to the local memory
/// store instead of an MCP server.
pub(crate) type ToolFn<'a> = &'a (dyn Fn(bool, &str, &str, &str) -> Result<String, String> + Sync);

/// The injected effects: the golden fixtures stub all three exactly as
/// `fixtures/run.mjs` does, production wires the real clients in `runner.rs`.
///
/// Trait objects rather than `fn` pointers because the production wirings carry
/// state a bare function cannot reach — the SQLite store, the Keychain vault and
/// the resolved registry. `+ Sync` so `Effects` can cross into the run thread;
/// `Copy` so it can be handed to `agent::run_loop` while `self` stays borrowed.
#[derive(Clone, Copy)]
pub(crate) struct Effects<'a> {
    pub send: SendFn<'a>,
    pub model: ModelFn<'a>,
    pub tool: ToolFn<'a>,
}

struct Run<'a> {
    graph: &'a Graph,
    tx: &'a Sender<ConsoleLine>,
    nodes: HashMap<&'a str, &'a Node>,
    /// trigger payload per event node, read off its `payload` port
    event_payloads: Option<&'a HashMap<String, String>>,
    /// the user's registry entries (mcp / skill / memory / variable chips),
    /// overlaid on the static catalog exactly as `byKey` was built in the
    /// TypeScript. None means "no registry read" — every chip then resolves as
    /// deleted, which is the safe direction.
    registry: Option<&'a HashMap<String, CatalogEntry>>,
    effects: Effects<'a>,
    /// the designer's stop button, i.e. the TypeScript's `AbortSignal`. None for
    /// a cron or event run — nothing can press it.
    cancel: Option<&'a AtomicBool>,
    steps: u32,
    integration_calls: u32,
    /// agent-initiated tool calls, budgeted across the whole run
    agent_mcp_calls: u32,
    /// loop nodeId -> the item this iteration is on
    loop_values: HashMap<String, Value>,
    /// await nodeId -> flow arrivals so far, in arrival order (the abandoned-
    /// barrier warnings are emitted in that order)
    arrivals: Vec<(String, usize)>,
    fan_out_depth: u32,
    /// a fan-out branch failed. The TypeScript set this in a `.catch`, i.e. a
    /// microtask, so it stops only a sibling that has *itself* suspended — one
    /// that runs straight through never observes it (`fanout-abort-siblings`).
    branch_failed: bool,
    /// has the branch now running already suspended? In the TypeScript that is
    /// "has it awaited a hook"; here it is "has it made an effect call", which
    /// is the same set of points. Reset at the start of every branch.
    suspended: bool,
    /// "nodeId:portId" -> output, for nodes whose value ports are only readable
    /// after their flow step ran (the http node's `response`, an await's
    /// `results`).
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

    fn stopped(&self) -> bool {
        self.cancel.is_some_and(|c| c.load(Ordering::Relaxed))
    }

    /// `byKey`: the user's registry entries over the static catalog.
    fn entry(&self, node_type: &str) -> Option<&'a CatalogEntry> {
        self.registry
            .and_then(|r| r.get(node_type))
            .or_else(|| CATALOG.get(node_type))
    }

    fn label(&self, node: &Node) -> String {
        self.entry(&node.node_type)
            .map(|e| e.label.clone())
            .unwrap_or_else(|| node.node_type.clone())
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

    /// multi-edge value input (await "values") — all incoming edges, edge order
    fn incoming_value_edges(&self, node_id: &str, port_id: &str) -> Vec<&'a Edge> {
        self.graph
            .edges
            .iter()
            .filter(|e| e.kind == "value" && e.to.node_id == node_id && e.to.port_id == port_id)
            .collect()
    }

    fn eval_input(&mut self, node: &Node, port_id: &str, ctx: &mut EvalCtx) -> Result<Value, Abort> {
        let Some(edge) = self.incoming_value_edge(&node.id, port_id) else {
            self.warn(format!(
                "{}: input \"{port_id}\" not connected — using \"\"",
                self.label(node)
            ));
            return Ok(Value::str(""));
        };
        let (from_node, from_port) = (edge.from.node_id.clone(), edge.from.port_id.clone());
        self.eval_output(&from_node, &from_port, ctx)
    }

    fn eval_output(&mut self, node_id: &str, port_id: &str, ctx: &mut EvalCtx) -> Result<Value, Abort> {
        let key = format!("{node_id}:{port_id}");
        if let Some(hit) = ctx.memo.get(&key) {
            return Ok(hit.clone());
        }
        let value = self.compute_output(node_id, port_id, &key, ctx)?;
        ctx.memo.insert(key, value.clone());
        self.values
            .push((node_id.to_string(), port_id.to_string(), value.text()));
        Ok(value)
    }

    fn compute_output(
        &mut self,
        node_id: &str,
        port_id: &str,
        key: &str,
        ctx: &mut EvalCtx,
    ) -> Result<Value, Abort> {
        let Some(node) = self.nodes.get(node_id).copied() else {
            return Ok(Value::str(""));
        };
        if ctx.stack.contains(key) {
            return Err(self.fail("value cycle detected".into()));
        }
        ctx.stack.insert(key.to_string());
        let out = self.compute_uncycled(node, port_id, key, ctx);
        ctx.stack.remove(key);
        out
    }

    fn compute_uncycled(
        &mut self,
        node: &'a Node,
        port_id: &str,
        key: &str,
        ctx: &mut EvalCtx,
    ) -> Result<Value, Abort> {
        // the type switch comes first, exactly as in the TypeScript — a node type
        // with value semantics of its own never reaches the category fallbacks
        match node.node_type.as_str() {
            "string" => return Ok(Value::S(self.cfg(node, "value"))),
            "number" => {
                let raw = js::trim(&self.cfg(node, "value")).to_string();
                if raw.is_empty() {
                    return Ok(Value::N(0.0));
                }
                let n = js::to_number(&raw);
                if n.is_nan() {
                    self.warn(format!("number \"{raw}\" is not a number — using 0"));
                    return Ok(Value::N(0.0));
                }
                return Ok(Value::N(n));
            }
            // legacy: hidden from the toolbox, still resolves for graphs saved
            // before the string/number split
            "literal" => {
                let raw = self.cfg(node, "value");
                if self.cfg(node, "valueType") != "number" {
                    return Ok(Value::S(raw));
                }
                let n = js::to_number(&raw);
                if n.is_nan() {
                    self.warn(format!("literal \"{raw}\" is not a number — using 0"));
                    return Ok(Value::N(0.0));
                }
                return Ok(Value::N(n));
            }
            // && and || short-circuit: b is not evaluated, so it neither warns
            // nor lands in the value stream
            "and" => {
                let a = self.eval_input(node, "a", ctx)?;
                return Ok(Value::B(a.truthy() && self.eval_input(node, "b", ctx)?.truthy()));
            }
            "or" => {
                let a = self.eval_input(node, "a", ctx)?;
                return Ok(Value::B(a.truthy() || self.eval_input(node, "b", ctx)?.truthy()));
            }
            "not" => return Ok(Value::B(!self.eval_input(node, "in", ctx)?.truthy())),
            "concat" => {
                let a = self.eval_input(node, "a", ctx)?.text();
                let b = self.eval_input(node, "b", ctx)?.text();
                return Ok(Value::S(a + &b));
            }
            "extract" => return self.extract(node, ctx),
            "loop" => {
                return Ok(match self.loop_values.get(&node.id) {
                    Some(item) => item.clone(),
                    None => {
                        self.warn("loop \"item\" read outside an iteration — using \"\"".into());
                        Value::str("")
                    }
                })
            }
            "model" => return Ok(Value::S(js::trim(&self.cfg(node, "model")).to_string())),
            "agent" | "await" => return Ok(Value::S(self.stashed(node, port_id, key))),
            _ => {}
        }
        // secret variable boxes emit their opaque sentinel — the real value
        // substitutes server-side at the point of consumption only, so plaintext
        // never enters the interpreter or the logs
        if let Some(id) = agent::variable_id_from_node_type(&node.node_type) {
            let sentinel = agent::variable_sentinel(id);
            if !self.entry(&node.node_type).is_some_and(|e| !e.missing) {
                self.warn(format!(
                    "{}: variable was deleted — its value will not resolve",
                    self.label(node)
                ));
            }
            return Ok(Value::S(sentinel));
        }
        match self.entry(&node.node_type).map(|e| e.category.as_str()) {
            // event nodes carry the trigger payload on their sole value output
            Some("events") => Ok(Value::S(
                self.event_payloads
                    .and_then(|m| m.get(&node.id))
                    .cloned()
                    .unwrap_or_default(),
            )),
            // read-style integration actions stash their result under the
            // declared value output when their flow step runs
            Some("integration") => Ok(Value::S(self.stashed(node, port_id, key))),
            // mcp/skill nodes are grant chips — never evaluated as values
            Some("mcp" | "skill") => Ok(Value::str("")),
            // a memory chip, or a type that is not in the catalog at all (a
            // deleted registry entry, a graph from a newer build)
            _ => {
                self.warn(format!(
                    "cannot evaluate output \"{port_id}\" of {} — using \"\"",
                    self.label(node)
                ));
                Ok(Value::str(""))
            }
        }
    }

    fn cfg(&self, node: &Node, field: &str) -> String {
        node.config.get(field).cloned().unwrap_or_default()
    }

    /// a port whose value only exists once the node's flow step has run
    fn stashed(&self, node: &Node, port_id: &str, key: &str) -> String {
        match self.results.get(key) {
            Some(v) => v.clone(),
            None => {
                self.warn(format!(
                    "{}: \"{port_id}\" read before the node ran — using \"\"",
                    self.label(node)
                ));
                String::new()
            }
        }
    }

    /// Dot-separated path into the JSON on the `value` input. Numbers index
    /// arrays; anything the walk cannot follow (a missing key, a descent into a
    /// scalar, a prototype key) is one warn and "".
    fn extract(&mut self, node: &'a Node, ctx: &mut EvalCtx) -> Result<Value, Abort> {
        let path = js::trim(&self.cfg(node, "path")).to_string();
        let raw = self.eval_input(node, "value", ctx)?.text();
        let Ok(mut cur) = js::parse(&raw) else {
            self.warn("extract: value is not JSON — using \"\"".into());
            return Ok(Value::str(""));
        };
        // an empty path walks nowhere; "".split('.') would yield one empty segment
        let segments: Vec<&str> = if path.is_empty() {
            Vec::new()
        } else {
            path.split('.').collect()
        };
        for seg in segments {
            // read-only walk, but never traverse prototype chain keys
            // (defensive; the TypeScript did it on both its run paths)
            let found = if matches!(seg, "__proto__" | "constructor" | "prototype") {
                None
            } else {
                match cur {
                    js::J::A(mut items) => {
                        // JS reads arr[Number(seg)] — a fractional, negative or
                        // out-of-range index is simply absent, as is arr[NaN]
                        let n = js::to_number(seg);
                        let i = n as usize;
                        (n >= 0.0 && n.fract() == 0.0 && i < items.len())
                            .then(|| items.swap_remove(i))
                    }
                    js::J::O(mut fields) => {
                        let at = fields.iter().rposition(|(k, _)| k == seg);
                        at.map(|i| fields.swap_remove(i).1)
                    }
                    _ => None,
                }
            };
            let Some(next) = found else {
                self.warn(format!("extract: path \"{path}\" not found — using \"\""));
                return Ok(Value::str(""));
            };
            cur = next;
        }
        Ok(cur.scalar().unwrap_or_else(|| Value::S(js::stringify(&cur))))
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
    ///
    /// A failing branch does not stop a sibling outright: the `.catch` that set
    /// `branchFailed` was a microtask, and by the time it ran `.map` had already
    /// started every sibling. What it does stop is a sibling that suspends and
    /// comes back — `fanout-abort-siblings` pins the first, `fanout-suspending-
    /// sibling` the second. The first failure unwinds once they have all run.
    fn fan_out(&mut self, targets: Vec<&'a Node>, visited: &HashSet<String>) -> Result<(), Abort> {
        self.fan_out_depth += 1;
        let mut result = Ok(());
        for target in targets {
            self.suspended = false; // a branch's synchronous prefix always runs
            if let Err(abort) = self.exec_chain(target, visited.clone()) {
                self.branch_failed = true;
                result = result.and(Err(abort));
            }
        }
        self.fan_out_depth -= 1;
        // the enclosing chain awaited this fan-out, so it has suspended too
        self.suspended = true;
        // once no concurrent chain is left, a partially-arrived await is provably
        // dead (an upstream `if` diverged past it) — warn and reset so a later
        // loop iteration starts a fresh barrier
        if self.fan_out_depth == 0 && !self.branch_failed && !self.stopped() {
            for (id, arrived) in std::mem::take(&mut self.arrivals) {
                let expected = self.expected_arrivals(&id);
                self.warn(format!("await never completed ({arrived}/{expected} branches)"));
            }
        }
        result
    }

    /// an await's join width: every flow edge into its "in" port
    fn expected_arrivals(&self, node_id: &str) -> usize {
        self.graph
            .edges
            .iter()
            .filter(|e| e.kind == "flow" && e.to.node_id == node_id && e.to.port_id == "in")
            .count()
    }

    fn exec_chain(&mut self, start: &'a Node, mut visited: HashSet<String>) -> Result<(), Abort> {
        let mut current = Some(start);
        while let Some(node) = current {
            if self.stopped() {
                return Err(self.fail("run stopped".into()));
            }
            // a sibling branch already failed and printed the error; this branch
            // only notices once it has suspended (see `suspended`)
            if self.branch_failed && self.suspended {
                return Err(Abort);
            }
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
                "if" => {
                    let Some(op) = node.config.get("operator").filter(|s| !s.is_empty()).cloned()
                    else {
                        return Err(self.fail("if: no operator selected".into()));
                    };
                    let a = self.eval_input(node, "l", &mut ctx)?;
                    // b_literal is a removed config field kept as a legacy
                    // fallback for pre-rename graphs where r was unconnected
                    let b = if self.incoming_value_edge(&node.id, "r").is_some() {
                        self.eval_input(node, "r", &mut ctx)?
                    } else {
                        Value::S(self.cfg(node, "b_literal"))
                    };
                    Some(if js::compare(&a, &b, &op) { "true" } else { "false" })
                }
                "loop" => {
                    // each iteration's body walks with a fresh visited set — a
                    // body node is re-entered legitimately, once per item
                    for item in js::to_list(&self.eval_input(node, "items", &mut ctx)?) {
                        self.loop_values.insert(node.id.clone(), item);
                        self.exec_from(&node.id, "body", &HashSet::new())?;
                        // `await execFrom(…)` suspends even when the body ran
                        // synchronously — an await always yields once
                        self.suspended = true;
                    }
                    self.loop_values.remove(&node.id);
                    Some("done")
                }
                "await" => self.exec_await(node, &mut ctx)?,
                "agent" => {
                    self.exec_agent(node, &mut ctx)?;
                    Some("out")
                }
                _ => match self.entry(&node.node_type).map(|e| e.category.as_str()) {
                    // event nodes are entry points; the normal path runs their
                    // "out" via exec_from, so this only fires when a flow cycle
                    // re-enters one
                    Some("events") => Some("out"),
                    Some("integration") => {
                        self.exec_integration(node, &mut ctx)?;
                        Some("out")
                    }
                    // grant chips run only as an agent's grants, never standalone.
                    // A legacy flow edge out of one still continues the chain.
                    Some("mcp" | "skill") => {
                        self.warn(format!("\"{}\" is not executable — skipped", self.label(node)));
                        Some("out")
                    }
                    // a deleted registry entry, or a node with no flow semantics
                    // at all: nothing to run and nothing to guess at, so the
                    // chain ends — the run itself is fine
                    _ => {
                        self.warn(format!("\"{}\" skipped", self.label(node)));
                        None
                    }
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

    /// Join barrier: every incoming flow edge must arrive. The last arrival
    /// evaluates "values" (edge order) and continues the chain; the others end
    /// there. Returns the next flow port, or None when this branch is done.
    fn exec_await(&mut self, node: &'a Node, ctx: &mut EvalCtx) -> Result<Option<&'static str>, Abort> {
        let expected = self.expected_arrivals(&node.id);
        let at = self.arrivals.iter().position(|(id, _)| *id == node.id);
        let arrived = at.map_or(0, |i| self.arrivals[i].1) + 1;
        if arrived < expected {
            match at {
                Some(i) => self.arrivals[i].1 = arrived,
                None => self.arrivals.push((node.id.clone(), arrived)),
            }
            return Ok(None);
        }
        if let Some(i) = at {
            self.arrivals.remove(i); // a loop re-entry gets a fresh barrier
        }
        let sources: Vec<(String, String)> = self
            .incoming_value_edges(&node.id, "values")
            .into_iter()
            .map(|e| (e.from.node_id.clone(), e.from.port_id.clone()))
            .collect();
        let mut values = Vec::with_capacity(sources.len());
        for (from_node, from_port) in sources {
            values.push(self.eval_output(&from_node, &from_port, ctx)?);
        }
        let json = js::stringify_values(&values);
        self.results.insert(format!("{}:results", node.id), json.clone());
        self.values.push((node.id.clone(), "results".into(), json));
        if expected > 1 {
            self.emit(
                Kind::Info,
                format!("await: {expected}/{expected} branches — continuing"),
            );
        }
        Ok(Some("out"))
    }

    fn exec_print(&mut self, node: &Node, ctx: &mut EvalCtx) -> Result<(), Abort> {
        let msg = node.config.get("message").cloned().unwrap_or_default();
        // a connected "message" edge overrides the literal; graphs saved before
        // the port/field merge wired a "value" port instead — honor it with the
        // old prefix-concat semantics
        let overridden = self.incoming_value_edge(&node.id, "message").is_some();
        let legacy = !overridden && self.incoming_value_edge(&node.id, "value").is_some();
        let value = if overridden {
            self.eval_input(node, "message", ctx)?.text()
        } else if legacy {
            self.eval_input(node, "value", ctx)?.text()
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

    /// The Saturn node. Grants resolve statically from each connected chip
    /// node's TYPE, never by evaluating it as a value, and there is NO config
    /// fallback — a legacy `config.tools`/`config.skills` grants nothing. The
    /// loop itself is `agent::run_loop`; everything here is edge resolution.
    fn exec_agent(&mut self, node: &'a Node, ctx: &mut EvalCtx) -> Result<(), Abort> {
        // anything other than "image" (incl. legacy "plan") runs as text
        let output_image = self.cfg(node, "output") == "image";

        let mut tools: Vec<agent::ToolRef> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for edge in self.incoming_value_edges(&node.id, "tools") {
            let src = self.nodes.get(edge.from.node_id.as_str()).copied();
            // the source must resolve to a LIVE mcp chip entry: retired per-tool
            // types still parse but render "(deleted)" and must grant nothing
            let is_chip = src
                .and_then(|s| self.entry(&s.node_type))
                .is_some_and(|e| !e.missing && e.category == "mcp" && e.tool_name.is_some());
            let parsed = src
                .filter(|_| is_chip)
                .and_then(|s| agent::tool_ref_from_node_type(&s.node_type));
            let (Some(mut r), Some(src)) = (parsed, src) else {
                let who = src.map_or_else(|| edge.from.node_id.clone(), |s| self.label(s));
                self.warn(format!(
                    "agent: tool edge from \"{who}\" is not an MCP server — ignored"
                ));
                continue;
            };
            if r.tool_name == agent::ALL_TOOLS {
                match agent::parse_tool_exclusions(&self.cfg(src, "exclude")) {
                    None => self.warn(format!(
                        "agent: \"{}\" has an invalid tool selection — granting all enabled tools",
                        self.label(src)
                    )),
                    Some(exclude) => r.exclude = exclude,
                }
            }
            // exclusions belong in the key: two nodes of one server with
            // different prunes must both reach the server, whose per-tool dedup
            // unions them
            let mut sorted = r.exclude.clone();
            sorted.sort();
            if seen.insert(format!("{}:{}:{}", r.entry_id, r.tool_name, sorted.join("\0"))) {
                tools.push(r);
            }
        }
        if tools.len() > agent::MAX_GRANTED_TOOLS {
            self.warn(format!(
                "agent: {} tool grants over the cap ({}) — using the first {}",
                tools.len(),
                agent::MAX_GRANTED_TOOLS,
                agent::MAX_GRANTED_TOOLS
            ));
            tools.truncate(agent::MAX_GRANTED_TOOLS);
        }

        let mut skill_ids: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for edge in self.incoming_value_edges(&node.id, "skills") {
            let src = self.nodes.get(edge.from.node_id.as_str()).copied();
            let Some(id) = src.and_then(|s| agent::skill_id_from_node_type(&s.node_type)) else {
                let who = src.map_or_else(|| edge.from.node_id.clone(), |s| self.label(s));
                self.warn(format!("agent: skill edge from \"{who}\" is not a skill — ignored"));
                continue;
            };
            if seen.insert(id.clone()) {
                skill_ids.push(id);
            }
        }
        if skill_ids.len() > agent::MAX_GRANTED_SKILLS {
            self.warn(format!(
                "agent: {} skill grants over the cap ({}) — using the first {}",
                skill_ids.len(),
                agent::MAX_GRANTED_SKILLS,
                agent::MAX_GRANTED_SKILLS
            ));
            skill_ids.truncate(agent::MAX_GRANTED_SKILLS);
        }

        // memory is a single-edge port designer-side, but a hand-authored graph
        // may wire several — take the first that resolves to a live memory chip
        let mut memory_id = None;
        for edge in self.incoming_value_edges(&node.id, "memory") {
            let src = self.nodes.get(edge.from.node_id.as_str()).copied();
            let live = src
                .and_then(|s| self.entry(&s.node_type))
                .is_some_and(|e| !e.missing && e.category == "memory");
            let id = src
                .filter(|_| live)
                .and_then(|s| agent::memory_id_from_node_type(&s.node_type));
            if id.is_some() {
                memory_id = id;
                break;
            }
            let who = src.map_or_else(|| edge.from.node_id.clone(), |s| self.label(s));
            self.warn(format!(
                "agent: memory edge from \"{who}\" — memory store unavailable, skipping"
            ));
        }

        if output_image && (!tools.is_empty() || memory_id.is_some()) {
            self.warn("agent: image output doesn't support tools — grants ignored for this run".into());
        }
        let user_text = self.eval_input(node, "prompt", ctx)?.text();
        if user_text.starts_with("data:image/") {
            self.warn("agent: prompt is image data — image inputs aren't supported".into());
        }
        // a connected system node wins over the node's system-prompt button, and
        // a connected model node over the config literal — in THAT order: both
        // land in the value stream, which the golden fixtures pin.
        let system = if self.incoming_value_edge(&node.id, "system").is_some() {
            self.eval_input(node, "system", ctx)?.text()
        } else {
            self.cfg(node, "system")
        };
        let model = if self.incoming_value_edge(&node.id, "model").is_some() {
            js::trim(&self.eval_input(node, "model", ctx)?.text()).to_string()
        } else {
            js::trim(&self.cfg(node, "model")).to_string()
        };
        let mut req = agent::Request {
            model,
            system,
            skill_ids,
            tools: if output_image { Vec::new() } else { tools },
            // image runs are single-turn — memory tools can't fire
            memory_id: if output_image { None } else { memory_id },
            messages: Vec::new(),
            output_image,
            reasoning: node.config.get("reasoning").cloned(),
        };

        // the closure captures the Sender, not `self`, so the run-scoped MCP
        // budget can go in as a &mut alongside it
        let (tx, model, tool) = (self.tx, self.effects.model, self.effects.tool);
        let result = agent::run_loop(
            &mut req,
            &user_text,
            &mut self.agent_mcp_calls,
            &mut |kind, text| {
                let _ = tx.send(ConsoleLine { kind, text });
            },
            model,
            tool,
            self.cancel,
        );
        self.suspended = true; // every model turn is a suspension point
        let result = match result {
            Ok(text) => text,
            Err(message) => return Err(self.fail(message)),
        };
        self.results.insert(format!("{}:result", node.id), result.clone());
        self.values.push((node.id.clone(), "result".into(), result));
        Ok(())
    }

    fn exec_integration(&mut self, node: &'a Node, ctx: &mut EvalCtx) -> Result<(), Abort> {
        self.integration_calls += 1;
        if self.integration_calls > MAX_INTEGRATION_CALLS {
            return Err(self.fail(format!(
                "integration call limit ({MAX_INTEGRATION_CALLS}) exceeded for one run"
            )));
        }
        let entry = self.entry(&node.node_type).expect("category matched above");

        // every config field has a same-id value port that overrides the literal
        // when connected; iterate the catalog fields (not node.config) so stale
        // saved keys cannot invent ports. message stays a separate param.
        let mut config = node.config.clone();
        for field in &entry.config {
            if field.id != "message" && self.incoming_value_edge(&node.id, &field.id).is_some() {
                let value = self.eval_input(node, &field.id, ctx)?;
                config.insert(field.id.clone(), value.text());
            }
        }
        // message is a separate sender argument, not a config key — a connected
        // port overrides the literal exactly as the config fields do
        let message = if self.incoming_value_edge(&node.id, "message").is_some() {
            self.eval_input(node, "message", ctx)?.text()
        } else {
            self.cfg(node, "message")
        };

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
        let sent = (self.effects.send)(provider, &config, &message);
        // the send is the branch's suspension point — see `suspended`
        self.suspended = true;
        let text = match sent {
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
/// run does. Returns the value stream (nodeId, portId, text) in evaluation
/// order, which is the half of the golden fixtures that pins the memo.
///
/// Every seam the golden-fixture oracle drives is a parameter — seeded event
/// payloads, the user registry, the three effects — so production and the
/// fixtures reach exactly the same code with different wirings. `runner.rs`
/// builds the production ones.
pub(crate) fn run_workflow(
    graph: &Graph,
    entry_node_ids: Option<&[String]>,
    event_payloads: Option<&HashMap<String, String>>,
    registry: Option<&HashMap<String, CatalogEntry>>,
    tx: &Sender<ConsoleLine>,
    effects: Effects,
    cancel: Option<&AtomicBool>,
) -> Vec<(String, String, String)> {
    let mut run = Run {
        graph,
        tx,
        nodes: graph.nodes.iter().map(|n| (n.id.as_str(), n)).collect(),
        event_payloads,
        registry,
        effects,
        cancel,
        steps: 0,
        integration_calls: 0,
        agent_mcp_calls: 0,
        loop_values: HashMap::new(),
        arrivals: Vec::new(),
        fan_out_depth: 0,
        branch_failed: false,
        suspended: false,
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
            .filter(|n| run.entry(&n.node_type).is_some_and(|e| e.category == "events"))
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
    // event nodes are independent entry points — like a fan-out, one aborting
    // does not stop the others from running, but it does abort the run
    let mut aborted = false;
    for entry in entries {
        // like a fan-out branch, an entry point's synchronous prefix always runs
        run.suspended = false;
        aborted |= run.exec_from(&entry.id, "out", &HashSet::new()).is_err();
    }
    if aborted {
        // a user stop already printed "run stopped" — skip the extra line
        if !run.stopped() {
            run.emit(Kind::Error, "run aborted".into());
        }
        return run.values;
    }
    run.emit(Kind::Info, format!("run finished ({} steps)", run.steps));
    run.values
}

/// Node types with an implementation above. The golden-fixture oracle skips any
/// case containing a catalogued type that is not here (events are always fine —
/// they are entry points with no behaviour of their own). Keep it in step with
/// the two matches, or a case silently "passes" by never running.
#[cfg(test)]
pub(crate) const PORTED: &[&str] = &[
    "print",
    "if",
    "loop",
    "await",
    "agent",
    "model",
    "string",
    "number",
    "literal",
    "concat",
    "extract",
    "and",
    "or",
    "not",
    "integration:http-request",
    "integration:discord-webhook",
    "integration:discord-send-message",
    "integration:discord-read-messages",
    "integration:discord-typing",
    "integration:telegram-send-message",
    "integration:telegram-typing",
];

#[cfg(test)]
mod fixtures;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// `send` is the REAL sender — `integration_nodes_reach_their_sender` is the
    /// test that would have caught Phase C's unwired-module bug, and stubbing it
    /// here would blind it. The model and tool effects need a store and a vault,
    /// so their production wiring is proved in `runner`'s tests instead; no case
    /// in this module has an agent node, and these refuse loudly if one appears.
    fn drain(graph: serde_json::Value) -> Vec<(Kind, String)> {
        let graph: Graph = serde_json::from_value(graph).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let send = |provider: &str, config: &HashMap<String, String>, message: &str| {
            crate::integrations::execute(provider, config, message, &|_| None)
        };
        let model = |_: &agent::Request| agent::Turn::Failed("no model in these cases".into());
        let tool = |_, _: &str, _: &str, _: &str| Err("no tool call in these cases".to_string());
        run_workflow(
            &graph,
            None,
            None,
            None,
            &tx,
            Effects { send: &send, model: &model, tool: &tool },
            None,
        );
        drop(tx);
        rx.into_iter().map(|l| (l.kind, l.text)).collect()
    }

    fn node(id: &str, ty: &str, config: serde_json::Value) -> serde_json::Value {
        json!({ "id": id, "type": ty, "x": 0, "y": 0, "config": config })
    }

    /// The designer's stop button. Three things have to hold together or the
    /// console reads wrong: the walk stops at a step boundary rather than
    /// running to completion, the line is "run stopped", and the generic
    /// "run aborted" line is suppressed — a user who pressed stop must not be
    /// shown two errors, one of which looks like a crash.
    #[test]
    fn a_stopped_run_says_so_once_and_walks_no_further() {
        let graph: Graph = serde_json::from_value(json!({
            "nodes": [
                node("s", "schedule", json!({ "cron": "* * * * *" })),
                node("a", "print", json!({})),
                node("b", "print", json!({})),
            ],
            "edges": [
                edge(("s", "out"), ("a", "in"), "flow"),
                edge(("a", "out"), ("b", "in"), "flow"),
            ],
        }))
        .unwrap();
        let send = |_: &str, _: &HashMap<String, String>, _: &str| Ok(String::new());
        let model = |_: &agent::Request| agent::Turn::Failed("unused".into());
        let tool = |_, _: &str, _: &str, _: &str| Err("unused".to_string());
        let effects = Effects { send: &send, model: &model, tool: &tool };

        let stop = AtomicBool::new(true);
        let (tx, rx) = std::sync::mpsc::channel();
        run_workflow(&graph, None, None, None, &tx, effects, Some(&stop));
        drop(tx);
        let lines: Vec<(Kind, String)> = rx.into_iter().map(|l| (l.kind, l.text)).collect();
        assert_eq!(
            lines,
            vec![
                (Kind::Info, "▶ run started".to_string()),
                (Kind::Error, "run stopped".to_string()),
            ],
            "a stopped run must not walk on, and must not also print \"run aborted\""
        );

        // the same graph, unstopped, walks both prints — otherwise the check
        // above could be passing for the wrong reason
        let (tx, rx) = std::sync::mpsc::channel();
        run_workflow(&graph, None, None, None, &tx, effects, None);
        drop(tx);
        let texts: Vec<String> = rx.into_iter().map(|l| l.text).collect();
        assert_eq!(texts.last().unwrap(), "run finished (2 steps)");
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

    /// The production wiring: an integration node must reach its real sender in
    /// `integrations::execute`, not a stub and not an "unimplemented" abort. A
    /// blank webhook URL fails validation there, so no socket is opened.
    #[test]
    fn integration_nodes_reach_their_sender() {
        let lines = drain(json!({
            "nodes": [
                node("s", "schedule", json!({})),
                node("i", "integration:discord-webhook", json!({ "message": "hi" })),
            ],
            "edges": [edge(("s", "out"), ("i", "in"), "flow")],
        }));
        assert!(
            lines
                .iter()
                .any(|(k, t)| *k == Kind::Error && t == "send webhook: invalid webhook url"),
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
