import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from "@/lib/workflow";

// snapshot-based undo/redo. moveNodes/setConfig are transient (replace
// present only) so drags and typing coalesce; the caller stashes the
// pre-gesture graph and dispatches commitDrag/commitConfig with it on
// pointerup/blur to record a single undo step.

export type History = {
    past: WorkflowGraph[];
    present: WorkflowGraph;
    future: WorkflowGraph[];
};

export type GraphAction =
    | { type: "addNode"; node: WorkflowNode }
    // duplicate-selection: pre-built copies land as one undo step
    | { type: "addNodes"; nodes: WorkflowNode[]; edges: WorkflowEdge[] }
    | { type: "moveNodes"; ids: string[]; dx: number; dy: number }
    | { type: "commitDrag"; before: WorkflowGraph }
    // Escape mid-drag: restore the pre-gesture graph, no history entry
    | { type: "cancelDrag"; before: WorkflowGraph }
    | { type: "addEdge"; edge: WorkflowEdge; replacing?: string[] }
    | { type: "deleteEdge"; id: string }
    | { type: "deleteNodes"; ids: string[] }
    | { type: "setConfig"; nodeId: string; field: string; value: string }
    | { type: "commitConfig"; before: WorkflowGraph }
    | { type: "undo" }
    | { type: "redo" };

const PAST_CAP = 100;

export const initHistory = (graph: WorkflowGraph): History => ({
    past: [],
    present: graph,
    future: [],
});

const pushPast = (past: WorkflowGraph[], snapshot: WorkflowGraph): WorkflowGraph[] =>
    [...past, snapshot].slice(-PAST_CAP);

// record the current present as an undo point and move to next
function step(history: History, next: WorkflowGraph): History {
    return { past: pushPast(history.past, history.present), present: next, future: [] };
}

// record a caller-provided pre-gesture snapshot; no-op if nothing changed
function commit(history: History, before: WorkflowGraph): History {
    if (before === history.present) return history;
    if (JSON.stringify(before) === JSON.stringify(history.present)) return history;
    return { past: pushPast(history.past, before), present: history.present, future: [] };
}

export function graphReducer(history: History, action: GraphAction): History {
    const g = history.present;

    switch (action.type) {
        case "addNode":
            return step(history, { ...g, nodes: [...g.nodes, action.node] });

        case "addNodes":
            if (!action.nodes.length) return history;
            return step(history, {
                nodes: [...g.nodes, ...action.nodes],
                edges: [...g.edges, ...action.edges],
            });

        case "moveNodes": {
            const ids = new Set(action.ids);
            return {
                ...history,
                present: {
                    ...g,
                    nodes: g.nodes.map((n) =>
                        ids.has(n.id) ? { ...n, x: n.x + action.dx, y: n.y + action.dy } : n,
                    ),
                },
            };
        }

        case "commitDrag":
        case "commitConfig":
            return commit(history, action.before);

        case "cancelDrag":
            return { ...history, present: action.before };

        case "addEdge": {
            const replacing = new Set(action.replacing ?? []);
            return step(history, {
                ...g,
                edges: [...g.edges.filter((e) => !replacing.has(e.id)), action.edge],
            });
        }

        case "deleteEdge":
            return step(history, { ...g, edges: g.edges.filter((e) => e.id !== action.id) });

        case "deleteNodes": {
            const ids = new Set(action.ids);
            if (!g.nodes.some((n) => ids.has(n.id))) return history;
            return step(history, {
                nodes: g.nodes.filter((n) => !ids.has(n.id)),
                edges: g.edges.filter(
                    (e) => !ids.has(e.from.nodeId) && !ids.has(e.to.nodeId),
                ),
            });
        }

        case "setConfig":
            return {
                ...history,
                present: {
                    ...g,
                    nodes: g.nodes.map((n) =>
                        n.id === action.nodeId
                            ? { ...n, config: { ...n.config, [action.field]: action.value } }
                            : n,
                    ),
                },
            };

        case "undo": {
            const previous = history.past.at(-1);
            if (!previous) return history;
            return {
                past: history.past.slice(0, -1),
                present: previous,
                future: [g, ...history.future],
            };
        }

        case "redo": {
            const [next, ...rest] = history.future;
            if (!next) return history;
            return { past: pushPast(history.past, g), present: next, future: rest };
        }
    }
}
