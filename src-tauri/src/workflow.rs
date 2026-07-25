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

use serde_json::Value;

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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
}
