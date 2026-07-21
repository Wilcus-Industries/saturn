"use client";

import {
    type Dispatch,
    type SetStateAction,
    useCallback,
    useDeferredValue,
    useEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
    useTransition,
} from "react";
import {
    CATALOG_BY_KEY,
    canConnect,
    type CatalogEntry,
    chipKind,
    defaultNodeConfig,
    edgesToReplace,
    entryStyles,
    missingEntry,
    type ValidationIssue,
    validateGraphStrict,
    type WorkflowGraph,
    type WorkflowNode,
    type WorkflowRow,
} from "@/lib/workflow";
import { type ConsoleLine, runWorkflow } from "@/lib/interpreter";
import { sampleEventPayload } from "@/lib/integrations";
// type-only import — compile-erased, safe in a client component
import type { OpenrouterModel } from "@/lib/openrouter.server";
import { callAgentModel, callIntegration, callMcpTool, callMemoryTool, callSandboxTool, saveWorkflow } from "./actions";
import Canvas, { type CanvasHandle, type PendingDrag } from "./canvas";
import ConsolePanel from "./console";
import type { PendingEdge } from "./edges";
import EntryIcon from "./entryIcon";
import {
    anchorOffsetY,
    GRID,
    grabOffsetY,
    HEADER_H,
    isModelEntry,
    NODE_W,
    nodeWidth,
} from "./geometry";
import ModelLogo from "./modelLogo";
import { graphReducer, initHistory } from "./graphReducer";
import type {
    OpenCronHandler,
    OpenInfoHandler,
    OpenPickerHandler,
    OpenSystemHandler,
    OpenToolsHandler,
    OpenVariableHandler,
    PortPointerDownHandler,
} from "./node";
import ChipInfoPopover from "./chipInfoPopover";
import CronPopover from "./cronPopover";
import SystemPopover from "./systemPopover";
import ToolPickerPopover from "./toolPickerPopover";
import { describeCron } from "@/lib/cron";
import { variableIdFromNodeType } from "@/lib/registry";
import PathPicker, { type PickerSample } from "./pathPicker";
import Toolbox from "./toolbox";
import Topbar from "./topbar";
import VariableModal, { type VariableRow } from "./variableModal";

// don't JSON.parse arbitrarily huge samples for the path picker
const MAX_SAMPLE_CHARS = 500_000;

// window pointer listeners for gestures that outlive their start element
// (toolbox spawn, port edge drags). Handlers live in a ref so the listeners
// attach once per gesture but always see the latest closures.
function useWindowDrag(
    active: boolean,
    handlers: {
        onMove: (e: PointerEvent) => void;
        onUp: (e: PointerEvent) => void;
        onCancel: () => void;
    },
) {
    const ref = useRef(handlers);
    useEffect(() => {
        ref.current = handlers;
    });
    useEffect(() => {
        if (!active) return;
        const onMove = (e: PointerEvent) => ref.current.onMove(e);
        const onUp = (e: PointerEvent) => ref.current.onUp(e);
        const onCancel = () => ref.current.onCancel();
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onCancel);
        return () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onCancel);
        };
    }, [active]);
}

export default function Designer({
    workflow,
    userCatalog,
    variables,
    openrouterModels,
    cronFloorMinutes,
}: {
    workflow: WorkflowRow;
    userCatalog: CatalogEntry[];
    // secret variables for the toolbox's pinned split (name + has-value only)
    variables: VariableRow[];
    // null = no credits and no OpenRouter key; [] = unlocked but fetch failed
    openrouterModels: OpenrouterModel[] | null;
    // tightest schedule interval the owner's tier allows — caps the cron picker
    cronFloorMinutes: number;
}) {
    const [history, dispatch] = useReducer(graphReducer, workflow.graph, initHistory);
    const present = history.present;

    // static catalog + user registry entries + "(deleted)" placeholders for
    // any node type that no longer resolves (deleted registry entry or a
    // node type removed from the static catalog)
    const byKey = useMemo(() => {
        const map: Record<string, CatalogEntry> = { ...CATALOG_BY_KEY };
        for (const entry of userCatalog) map[entry.key] = entry;
        for (const n of present.nodes) {
            if (!map[n.type]) map[n.type] = missingEntry(n.type);
        }
        return map;
    }, [userCatalog, present.nodes]);

    // slug → output modalities, driving the agent node's output select
    const modelModalities = useMemo(
        () => new Map((openrouterModels ?? []).map((m) => [m.id, m.outputModalities])),
        [openrouterModels],
    );
    // slug → reasoning capability, driving the agent node's reasoning select
    const modelReasoning = useMemo(
        () => new Map((openrouterModels ?? []).map((m) => [m.id, m.supportsReasoning])),
        [openrouterModels],
    );

    // live validation surfaced in the topbar (issues panel) and as per-node
    // dots. The deferred graph IS the debounce — present settles between edits,
    // and validateGraphStrict is linear over a graph capped at MAX_NODES, so
    // re-running it per settled edit is cheap. Suppressed on an empty graph so a
    // fresh workflow doesn't nag ("no event node") before anything is placed.
    const deferredGraph = useDeferredValue(present);
    const validation = useMemo(
        () => validateGraphStrict(deferredGraph, byKey),
        [deferredGraph, byKey],
    );
    const issues = useMemo<ValidationIssue[]>(
        () => (deferredGraph.nodes.length === 0 ? [] : validation.issues),
        [deferredGraph, validation],
    );
    // node id → the worst level an issue pins to it (error wins over warning);
    // a node absent from the map has no issue. Feeds the canvas's per-node dot.
    const issuesByNode = useMemo(() => {
        const map = new Map<string, "error" | "warning">();
        for (const issue of issues) {
            if (!issue.nodeId) continue;
            if (issue.level === "error") map.set(issue.nodeId, "error");
            else if (!map.has(issue.nodeId)) map.set(issue.nodeId, "warning");
        }
        return map;
    }, [issues]);

    // selection lives outside history so undo/redo doesn't thrash it
    const [selection, setSelection] = useState<Set<string>>(new Set());
    // the selected edge (null = none). Node and edge selection are mutually
    // exclusive: every node-selection change routes through selectNodes, which
    // also clears the edge; selectEdge does the reverse. An edge click selects
    // it (no longer instant-deletes); Delete/Backspace or the midpoint × removes.
    const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
    const selectNodes = useCallback<Dispatch<SetStateAction<Set<string>>>>((update) => {
        setSelectedEdgeId(null);
        setSelection(update);
    }, []);
    const selectEdge = useCallback((id: string) => {
        setSelectedEdgeId(id);
        setSelection(new Set());
    }, []);
    const deleteEdge = useCallback((id: string) => {
        dispatch({ type: "deleteEdge", id });
    }, []);
    // clicking a node-bearing issue in the topbar's issues panel selects that
    // node — routed through selectNodes (stable), which also clears any edge
    // selection so the two selection kinds stay mutually exclusive
    const selectIssueNode = useCallback(
        (nodeId: string) => selectNodes(new Set([nodeId])),
        [selectNodes],
    );

    // saved snapshot as state (not a ref) so a successful save re-renders
    // the dirty indicator immediately
    const [savedJson, setSavedJson] = useState(() => JSON.stringify(workflow.graph));
    const dirty = useMemo(() => JSON.stringify(present) !== savedJson, [present, savedJson]);

    const [error, setError] = useState<string | null>(null);

    // transient toast: a bottom-center monospace pill that auto-dismisses after
    // ~2.5s; a fresh notify() replaces whatever is showing. Consumed by the edge
    // drop handler below (invalid-drop reasons + replaced-connection notice) and
    // later phases (failed-spawn feedback), without threading new props through
    // the memoized Node. Never persisted — dies with the page.
    const [toast, setToast] = useState<string | null>(null);
    const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const notify = useCallback((text: string) => {
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        setToast(text);
        toastTimerRef.current = setTimeout(() => setToast(null), 2500);
    }, []);
    useEffect(() => () => {
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    }, []);

    // arrow-key nudge coalescing: a burst of arrow presses moves the selection
    // one grid cell each via TRANSIENT moveNodes (same action a live drag uses
    // mid-gesture — no history push), then a settle timer commits the whole
    // burst as ONE undo step through the existing before/commitDrag machinery.
    // `before` snapshots the graph on the first press of a burst. Flushed early
    // by any non-arrow key action, a selection change, or unmount (see below).
    const nudgeRef = useRef<{
        before: WorkflowGraph | null;
        timer: ReturnType<typeof setTimeout> | null;
    }>({ before: null, timer: null });
    const flushNudge = useCallback(() => {
        const n = nudgeRef.current;
        if (n.timer) {
            clearTimeout(n.timer);
            n.timer = null;
        }
        if (n.before) {
            dispatch({ type: "commitDrag", before: n.before });
            n.before = null;
        }
    }, []);
    // a selection change means the user did something other than nudge (clicked
    // a node, marqueed, cleared) — the burst is over, so commit it. The nudge
    // itself never touches selection, so this never fires mid-burst. No-op when
    // nothing is pending (mount, ordinary selection churn).
    useEffect(() => {
        flushNudge();
    }, [selection, flushNudge]);

    // test-run output; null = console hidden (never run, or closed)
    const [consoleLines, setConsoleLines] = useState<ConsoleLine[] | null>(null);
    // console panel height, drag-resized via its top edge; lives here (not in
    // ConsolePanel) so it survives close/reopen but dies with the page —
    // deliberately never persisted
    const [consoleHeight, setConsoleHeight] = useState(160);
    const [running, setRunning] = useState(false);

    // the test event runner: every event node is an independent entry point,
    // labelled by its schedule (or the entry label for non-schedule events)
    const events = useMemo(
        () =>
            present.nodes
                .filter((n) => byKey[n.type]?.category === "events")
                .map((n) => {
                    const entry = byKey[n.type];
                    const cron = (n.config.cron ?? "").trim();
                    const label = entry?.config?.some((f) => f.id === "cron")
                        ? cron
                            ? describeCron(cron)
                            : "not scheduled"
                        : (entry?.label ?? n.type);
                    return { id: n.id, label };
                }),
        [present.nodes, byKey],
    );
    const [selectedEventId, setSelectedEventId] = useState("");
    // keep the selected event valid as the graph changes; default to the first
    const [prevEventKey, setPrevEventKey] = useState("");
    const eventKey = events.map((e) => e.id).join(",");
    if (prevEventKey !== eventKey) {
        setPrevEventKey(eventKey);
        if (!events.some((e) => e.id === selectedEventId)) {
            setSelectedEventId(events[0]?.id ?? "");
        }
    }

    // per-port values from the last test run, for the extract path picker.
    // A ref: nothing renders from these until a picker opens (which snapshots
    // what it needs). Never persisted — samples die with the page.
    const samplesRef = useRef(new Map<string, string>()); // "nodeId:portId" → text
    const abortRef = useRef<AbortController | null>(null);
    const runGraph = async () => {
        if (running) return;
        setRunning(true);
        setConsoleLines([]);
        samplesRef.current = new Map();
        const controller = new AbortController();
        abortRef.current = controller;
        const emit = (line: ConsoleLine) => setConsoleLines((prev) => [...(prev ?? []), line]);
        // seed each platform event node with its canned sample payload so a
        // payload → extract chain runs against realistic data in a test run;
        // schedule/unknown events have no sample (empty string, skipped)
        const eventPayloads: Record<string, string> = {};
        for (const n of present.nodes) {
            const payload = sampleEventPayload(n.type);
            if (payload) eventPayloads[n.id] = payload;
        }
        try {
            await runWorkflow(present, byKey, {
                emit,
                callMcp: callMcpTool,
                callMemory: callMemoryTool,
                callSandbox: callSandboxTool,
                callIntegration,
                callAgent: callAgentModel,
                onValue: (nodeId, portId, text) =>
                    samplesRef.current.set(`${nodeId}:${portId}`, text),
                signal: controller.signal,
            }, {
                entryNodeIds: selectedEventId ? [selectedEventId] : undefined,
                eventPayloads,
            });
        } catch (err) {
            emit({ kind: "error", text: `run crashed: ${String(err)}` });
        } finally {
            abortRef.current = null;
            setRunning(false);
        }
    };
    const stopRun = () => abortRef.current?.abort();

    // adjust-state-during-render: when the graph changes (edit/undo/redo),
    // prune selection to surviving nodes and clear a stale "save failed"
    const [prevPresent, setPrevPresent] = useState(present);
    if (prevPresent !== present) {
        setPrevPresent(present);
        const alive = new Set(present.nodes.map((n) => n.id));
        const kept = [...selection].filter((id) => alive.has(id));
        if (kept.length !== selection.size) setSelection(new Set(kept));
        // drop a stale edge selection (edge deleted, or its node removed)
        if (selectedEdgeId && !present.edges.some((e) => e.id === selectedEdgeId)) {
            setSelectedEdgeId(null);
        }
        if (error) setError(null);
    }

    // toolbox drag-spawn: the toolbox captures the pointer on pointerdown and
    // hands us the key; a ghost chip follows the pointer (fixed, client
    // coords) and pointerup inside the canvas adds the node at the world point
    const canvasRef = useRef<CanvasHandle>(null);
    const [spawn, setSpawn] = useState<{
        key: string;
        x: number;
        y: number;
        // preset from the toolbox chip (openrouter model chips prefill
        // config.model and show the model's display name on the ghost)
        config?: Record<string, string>;
        label?: string;
    } | null>(null);
    const spawnEntry = spawn ? byKey[spawn.key] : null;

    const spawnKey = spawn?.key ?? null;
    useWindowDrag(spawnKey !== null, {
        onMove: (e) => setSpawn((s) => (s ? { ...s, x: e.clientX, y: e.clientY } : s)),
        onUp: (e) => {
            const preset = spawn?.config;
            setSpawn(null);
            if (!spawnKey) return; // no active spawn (unreachable — guarded above)
            const point = canvasRef.current?.clientToWorld(e.clientX, e.clientY);
            // clientToWorld returns null when the pointer is outside the canvas
            // bounds — the drop missed its target, so say so instead of no-oping
            if (!point) {
                notify("drop on the canvas to place the node");
                return;
            }
            // one event node per workflow — the toolbox chip is already disabled
            // when one exists; this guards any other drop path (e.g. dropping a
            // ghost that was mid-flight when the graph gained its event)
            if (byKey[spawnKey]?.category === "events" && events.length > 0) {
                notify("one event node per workflow — remove the existing one first");
                return;
            }
            // same grid as the canvas dots and drag-end snapping
            const snap = (value: number) => Math.round(value / GRID) * GRID;
            // rectangles drop with the header centered under the pointer;
            // model circles / event blocks / grant chips center the block itself
            // (grabOffsetY encodes the per-shape grab center — see geometry.ts)
            const entry = byKey[spawnKey];
            const w = entry ? nodeWidth(entry) : NODE_W;
            const dy = entry ? grabOffsetY(entry) : HEADER_H / 2;
            // fresh object per spawn — never share a mutable config; catalog
            // field defaults seed first, a toolbox preset wins
            const config = { ...(entry ? defaultNodeConfig(entry) : {}), ...(preset ?? {}) };
            // x snaps the left edge; y snaps the node's primary port axis (the
            // literal box's height needs the config) so it drops grid-aligned to
            // the same axis drag-end settles onto — see anchorOffsetY
            const off = entry ? anchorOffsetY(entry, { config } as WorkflowNode) : HEADER_H / 2;
            const rawY = point.y - dy;
            dispatch({
                type: "addNode",
                node: {
                    id: crypto.randomUUID(),
                    type: spawnKey,
                    x: snap(point.x - w / 2),
                    y: Math.round((rawY + off) / GRID) * GRID - off,
                    config,
                },
            });
        },
        onCancel: () => setSpawn(null),
    });

    // port drag → edge creation. The port button holds pointer capture, so
    // pointermove/up bubble to window regardless of what's under the pointer.
    const [pendingDrag, setPendingDrag] = useState<PendingDrag | null>(null);
    const [pendingPoint, setPendingPoint] = useState<{ x: number; y: number } | null>(null);

    const startEdgeDrag: PortPointerDownHandler = useCallback((e, nodeId, portId, kind, dir) => {
        setPendingDrag({ from: { nodeId, portId }, kind, dir });
        setPendingPoint(canvasRef.current?.clientToWorld(e.clientX, e.clientY) ?? null);
    }, []);

    useWindowDrag(pendingDrag !== null, {
        onMove: (e) => {
            const point = canvasRef.current?.clientToWorld(e.clientX, e.clientY);
            if (point) setPendingPoint(point);
        },
        onUp: (e) => {
            if (!pendingDrag) return;
            setPendingDrag(null);
            setPendingPoint(null);
            // pointer capture retargets pointerup to the port button — the
            // drop target must be resolved geometrically, never from e.target
            const target = document
                .elementFromPoint(e.clientX, e.clientY)
                ?.closest<HTMLElement>("[data-port]");
            // dropping on empty canvas (nothing under the cursor) is a legit
            // cancel gesture — stay silent. Every other bare-return below became
            // a specific toast so the drop never fails wordlessly.
            if (!target) return;
            const { nodeId, portId, kind, dir } = target.dataset;
            if (!nodeId || !portId) return; // a [data-port] element always carries both
            if (kind !== pendingDrag.kind) {
                notify("flow and value ports don't connect");
                return;
            }
            if (dir !== "in" && dir !== "out") return; // malformed dataset (unreachable)
            if (dir === pendingDrag.dir) {
                notify("connect an output to an input");
                return;
            }
            // drags may start from an input port — the stored edge is always out→in
            const drop = { nodeId, portId };
            const [from, to] =
                pendingDrag.dir === "out" ? [pendingDrag.from, drop] : [drop, pendingDrag.from];
            // ordered cheap reason checks so the failure names the actual
            // problem; canConnect stays authoritative for the final accept.
            if (from.nodeId === to.nodeId) {
                notify("can't connect a node to itself");
                return;
            }
            const toNode = present.nodes.find((n) => n.id === to.nodeId);
            const toPort = toNode ? byKey[toNode.type]?.inputs.find((p) => p.id === to.portId) : undefined;
            const fromNode = present.nodes.find((n) => n.id === from.nodeId);
            const srcChip = chipKind(fromNode ? byKey[fromNode.type] : undefined);
            if (toPort?.accepts && srcChip !== toPort.accepts) {
                notify(`this port only takes a ${toPort.accepts} chip`);
                return;
            }
            if (srcChip && !toPort?.accepts) {
                notify("grant chips only connect to an agent's matching port");
                return;
            }
            const duplicate = present.edges.some(
                (edge) =>
                    edge.from.nodeId === from.nodeId && edge.from.portId === from.portId &&
                    edge.to.nodeId === to.nodeId && edge.to.portId === to.portId,
            );
            if (duplicate) {
                notify("already connected");
                return;
            }
            if (!canConnect(present, from, to, byKey)) {
                notify("can't connect these ports");
                return;
            }
            // the value-input single-edge limit replaces the old edge atomically
            // — one history entry for the whole swap (flow outputs fan out;
            // await "values" is multi-edge)
            const replacing = edgesToReplace(present, from, to, byKey);
            dispatch({
                type: "addEdge",
                edge: { id: crypto.randomUUID(), from, to, kind: pendingDrag.kind },
                replacing,
            });
            if (replacing.length) notify("replaced the existing connection");
        },
        onCancel: () => {
            setPendingDrag(null);
            setPendingPoint(null);
        },
    });

    const pendingEdge: PendingEdge | null =
        pendingDrag && pendingPoint
            ? { from: pendingDrag.from, kind: pendingDrag.kind, toWorldPoint: pendingPoint }
            : null;

    // extract path picker: the sample is resolved once at open (stable while
    // the popover is up) and `before` snapshots the graph for one undo step
    const [picker, setPicker] = useState<{
        nodeId: string;
        fieldId: string;
        anchor: { x: number; y: number };
        sample: PickerSample;
        before: WorkflowGraph;
    } | null>(null);

    // stable (reads through refs) so the memoized Node isn't re-rendered by
    // a new handler identity every designer render
    const openPicker: OpenPickerHandler = useCallback((anchor, nodeId, fieldId) => {
        const graph = graphRef.current;
        // the sample comes from whatever feeds the node's first value input —
        // derived from the catalog entry so this isn't coupled to extract's
        // port naming
        const node = graph.nodes.find((n) => n.id === nodeId);
        const entry = node ? byKeyRef.current[node.type] : undefined;
        // sample the port that actually feeds this field: when the field
        // declares an overriddenBy port (paired input), read that port's edge;
        // otherwise fall back to the node's first value input (extract's
        // historical behavior — its `path` field has no overriddenBy)
        const field = entry?.config?.find((f) => f.id === fieldId);
        const portId = field?.overriddenBy ?? entry?.inputs.find((p) => p.kind === "value")?.id;
        const edge = portId
            ? graph.edges.find(
                  (e) =>
                      e.kind === "value" &&
                      e.to.nodeId === nodeId &&
                      e.to.portId === portId,
              )
            : undefined;
        let sample: PickerSample;
        if (!edge) {
            sample = { kind: "no-edge" };
        } else {
            const text = samplesRef.current.get(`${edge.from.nodeId}:${edge.from.portId}`);
            if (text === undefined) sample = { kind: "no-sample" };
            else if (text.length > MAX_SAMPLE_CHARS) sample = { kind: "too-large" };
            else {
                try {
                    sample = { kind: "json", value: JSON.parse(text) };
                } catch {
                    sample = { kind: "raw", text };
                }
            }
        }
        setPicker({ nodeId, fieldId, anchor, sample, before: graph });
    }, []);

    const handlePick = (path: string) => {
        if (!picker) return;
        dispatch({ type: "setConfig", nodeId: picker.nodeId, field: picker.fieldId, value: path });
        dispatch({ type: "commitConfig", before: picker.before });
        setPicker(null);
    };

    // schedule-node cron popover: `before` snapshots the graph so the whole
    // editing session collapses into one undo step, committed on close
    const [cronEdit, setCronEdit] = useState<{
        nodeId: string;
        anchor: { x: number; y: number };
        initial: string;
        before: WorkflowGraph;
    } | null>(null);

    const openCron: OpenCronHandler = useCallback((anchor, nodeId) => {
        const graph = graphRef.current;
        const node = graph.nodes.find((n) => n.id === nodeId);
        setCronEdit({ nodeId, anchor, initial: node?.config.cron ?? "", before: graph });
    }, []);

    const handleCronChange = useCallback((cron: string) => {
        setCronEdit((cur) => {
            if (cur) dispatch({ type: "setConfig", nodeId: cur.nodeId, field: "cron", value: cron });
            return cur;
        });
    }, []);
    const closeCron = () => {
        if (cronEdit) dispatch({ type: "commitConfig", before: cronEdit.before });
        setCronEdit(null);
    };

    // mcp-server-node tool picker popover: same before/commit undo coalescing
    // as the cron popover — one undo step for the whole editing session
    const [toolsEdit, setToolsEdit] = useState<{
        nodeId: string;
        anchor: { x: number; y: number };
        before: WorkflowGraph;
    } | null>(null);

    const openTools: OpenToolsHandler = useCallback((anchor, nodeId) => {
        setToolsEdit({ nodeId, anchor, before: graphRef.current });
    }, []);

    const handleToolsChange = (value: string) => {
        setToolsEdit((cur) => {
            if (cur) dispatch({ type: "setConfig", nodeId: cur.nodeId, field: "exclude", value });
            return cur;
        });
    };
    const closeTools = () => {
        if (toolsEdit) dispatch({ type: "commitConfig", before: toolsEdit.before });
        setToolsEdit(null);
    };

    // agent-node system-prompt popover: same before/commit undo coalescing as
    // the cron popover — the whole editing session is one undo step. `initial`
    // snapshots config.system when the popover opens; the textarea drives itself
    // and each keystroke dispatches setConfig onto the graph.
    const [systemEdit, setSystemEdit] = useState<{
        nodeId: string;
        anchor: { x: number; y: number };
        initial: string;
        before: WorkflowGraph;
    } | null>(null);

    const openSystem: OpenSystemHandler = useCallback((anchor, nodeId) => {
        const graph = graphRef.current;
        const node = graph.nodes.find((n) => n.id === nodeId);
        setSystemEdit({ nodeId, anchor, initial: node?.config.system ?? "", before: graph });
    }, []);

    const handleSystemChange = useCallback((value: string) => {
        setSystemEdit((cur) => {
            if (cur)
                dispatch({ type: "setConfig", nodeId: cur.nodeId, field: "system", value });
            return cur;
        });
    }, []);
    const closeSystem = () => {
        if (systemEdit) dispatch({ type: "commitConfig", before: systemEdit.before });
        setSystemEdit(null);
    };

    // skill/memory chip info popover: read-only, so no undo coalescing — the
    // entry is resolved through byKeyRef at open time (memo-safe, like the
    // other popover openers) and snapshotted into state
    const [infoView, setInfoView] = useState<{
        anchor: { x: number; y: number };
        entry: CatalogEntry;
    } | null>(null);
    const openInfo: OpenInfoHandler = useCallback((anchor, nodeId) => {
        const node = graphRef.current.nodes.find((n) => n.id === nodeId);
        const entry = node ? byKeyRef.current[node.type] : undefined;
        if (entry) setInfoView({ anchor, entry });
    }, []);

    // secret-variable edit modal, lifted out of the toolbox so a variable node
    // on the canvas can open it too. "new" (toolbox +add) / a row (toolbox edit
    // or a canvas node click) / null closed. A canvas click resolves the row by
    // uuid from the node type via variablesRef (memo-safe stable callback).
    const [variableModal, setVariableModal] = useState<VariableRow | "new" | null>(null);
    const openVariable: OpenVariableHandler = useCallback((nodeId) => {
        const node = graphRef.current.nodes.find((n) => n.id === nodeId);
        const id = node ? variableIdFromNodeType(node.type) : null;
        const row = id ? variablesRef.current.find((v) => v.id === id) : undefined;
        if (row) setVariableModal(row);
    }, []);

    const [saving, startSaving] = useTransition();
    const save = () => {
        if (saving || !dirty) return;
        setError(null);
        const json = JSON.stringify(present);
        startSaving(async () => {
            try {
                await saveWorkflow(workflow.id, present);
                setSavedJson(json);
            } catch {
                setError("save failed");
            }
        });
    };

    // autosave: debounce after the last change; back off after a failure.
    // `present` in deps restarts the timer on every edit, so transient drag
    // frames keep pushing the save out until the graph settles — but nothing
    // else (selection churn, console lines streaming in) resets it.
    useEffect(() => {
        if (!dirty || saving) return;
        const id = setTimeout(save, error ? 5000 : 800);
        return () => clearTimeout(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- save is rebuilt every render; these deps cover everything it reads
    }, [present, dirty, saving, error]);

    // live mirrors for stable callbacks (memoized Node re-renders only when
    // its own props change, so anything it reads mid-gesture comes through
    // refs) and for the unmount flush below
    const graphRef = useRef(present);
    const savedJsonRef = useRef(savedJson);
    const byKeyRef = useRef(byKey);
    const selectionRef = useRef(selection);
    // live mirror of the variables prop so openVariable (a stable callback fed
    // to the memoized Node) resolves the clicked row without re-identifying
    const variablesRef = useRef(variables);
    useEffect(() => {
        // eslint-disable-next-line react-hooks/immutability -- deliberate live-mirror refs, written in an effect (never during render)
        graphRef.current = present;
        savedJsonRef.current = savedJson;
        // eslint-disable-next-line react-hooks/immutability -- see above
        byKeyRef.current = byKey;
        selectionRef.current = selection;
        // eslint-disable-next-line react-hooks/immutability -- see above
        variablesRef.current = variables;
    });

    // flush on unmount: in-app navigation (e.g. "← workflows") doesn't fire
    // beforeunload, and edits inside the debounce window would be lost.
    // Fire-and-forget — the SPA stays alive across client-side navigation.
    useEffect(() => {
        return () => {
            // commit any pending nudge FIRST (also clears its settle timer so it
            // can't fire post-unmount), before this flush reads graphRef. The
            // transient moves already live in graphRef, so the save is correct
            // either way — this ordering is about the timer and undo hygiene.
            flushNudge();
            if (JSON.stringify(graphRef.current) !== savedJsonRef.current) {
                saveWorkflow(workflow.id, graphRef.current).catch(() => {});
            }
        };
    }, [workflow.id, flushNudge]);

    // warn before leaving with unsaved changes
    useEffect(() => {
        if (!dirty) return;
        const warn = (e: BeforeUnloadEvent) => e.preventDefault();
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);

    // Cmd/Ctrl+D: copies of the selected nodes plus the edges running between
    // them, offset a grid cell, selected afterwards; one undo step
    const duplicateSelection = () => {
        // one event node per workflow — never copy event nodes (duplicating a
        // graph that already has one would create a second)
        const copyable = present.nodes.filter(
            (n) => selection.has(n.id) && byKey[n.type]?.category !== "events",
        );
        if (!copyable.length) return;
        const idMap = new Map(copyable.map((n) => [n.id, crypto.randomUUID()]));
        const nodes = copyable.map((n) => ({
            ...n,
            id: idMap.get(n.id)!,
            x: n.x + GRID,
            y: n.y + GRID,
            config: { ...n.config },
        }));
        const edges = present.edges
            .filter((e) => idMap.has(e.from.nodeId) && idMap.has(e.to.nodeId))
            .map((e) => ({
                ...e,
                id: crypto.randomUUID(),
                from: { ...e.from, nodeId: idMap.get(e.from.nodeId)! },
                to: { ...e.to, nodeId: idMap.get(e.to.nodeId)! },
            }));
        dispatch({ type: "addNodes", nodes, edges });
        selectNodes(new Set(nodes.map((n) => n.id)));
    };

    // one window keydown handler; re-attached each render so it always sees
    // fresh state (cheap, avoids a ref dance)
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            const key = e.key.toLowerCase();
            const mod = e.metaKey || e.ctrlKey;
            // any non-arrow key ends a pending nudge burst, committing it as one
            // undo step before this key's own action (delete/undo/duplicate/…)
            if (!e.key.startsWith("Arrow")) flushNudge();
            if (mod && key === "s") {
                e.preventDefault();
                save();
                return;
            }
            const target = e.target as HTMLElement;
            if (
                target instanceof HTMLInputElement ||
                target instanceof HTMLTextAreaElement ||
                target instanceof HTMLSelectElement
            ) {
                return;
            }
            if (e.key === "Backspace" || e.key === "Delete") {
                // a selected edge deletes first — before the node fall-through
                if (selectedEdgeId) dispatch({ type: "deleteEdge", id: selectedEdgeId });
                else if (selection.size) dispatch({ type: "deleteNodes", ids: [...selection] });
            } else if (mod && key === "z") {
                e.preventDefault();
                dispatch({ type: e.shiftKey ? "redo" : "undo" });
            } else if (mod && key === "y") {
                e.preventDefault();
                dispatch({ type: "redo" });
            } else if (mod && key === "a") {
                e.preventDefault();
                selectNodes(new Set(present.nodes.map((n) => n.id)));
            } else if (mod && key === "d") {
                e.preventDefault();
                duplicateSelection();
            } else if (e.key.startsWith("Arrow") && selection.size) {
                // nudge the selection one grid cell; a burst of presses coalesces
                // into ONE undo step via a settle timer (see nudgeRef/flushNudge)
                e.preventDefault();
                const dx = e.key === "ArrowLeft" ? -GRID : e.key === "ArrowRight" ? GRID : 0;
                const dy = e.key === "ArrowUp" ? -GRID : e.key === "ArrowDown" ? GRID : 0;
                if (dx === 0 && dy === 0) return; // a non-directional arrow (unreachable)
                const n = nudgeRef.current;
                if (!n.before) n.before = present; // first press of the burst snapshots
                if (n.timer) clearTimeout(n.timer);
                dispatch({ type: "moveNodes", ids: [...selection], dx, dy });
                n.timer = setTimeout(flushNudge, 500);
            } else if (e.key === "Escape") {
                // Escape ladder (bubble phase). Ordering contract: a node's
                // drag-cancel listener runs in the CAPTURE phase and
                // stopPropagation()s while a node drag is active, so this ladder
                // is skipped during a drag (no double-fire clearing the
                // selection). It only reaches here when no node drag is active.
                if (cronEdit) closeCron();
                else if (toolsEdit) closeTools();
                else if (systemEdit) closeSystem();
                else if (infoView) setInfoView(null);
                else if (picker) setPicker(null);
                else if (pendingDrag) {
                    setPendingDrag(null);
                    setPendingPoint(null);
                } else if (spawn) setSpawn(null);
                else if (selectedEdgeId) setSelectedEdgeId(null);
                else setSelection(new Set());
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    });

    return (
        <div className={"flex h-dvh flex-col bg-background"}>
            <Topbar
                workflowId={workflow.id}
                emoji={workflow.emoji}
                name={workflow.name}
                dirty={dirty}
                saving={saving}
                error={error}
                issues={issues}
                onSelectIssue={selectIssueNode}
                events={events}
                selectedEventId={selectedEventId}
                onSelectEvent={setSelectedEventId}
                onRun={runGraph}
                onStop={stopRun}
                running={running}
            />
            <div className={"flex min-h-0 flex-1"}>
                <Toolbox
                    userCatalog={userCatalog}
                    variables={variables}
                    openrouterModels={openrouterModels}
                    hasEvent={events.length > 0}
                    onSpawnStart={(key, x, y, preset) =>
                        setSpawn({ key, x, y, config: preset?.config, label: preset?.label })
                    }
                    onEditVariable={setVariableModal}
                />
                <Canvas
                    ref={canvasRef}
                    graph={present}
                    graphRef={graphRef}
                    byKey={byKey}
                    selection={selection}
                    selectionRef={selectionRef}
                    setSelection={selectNodes}
                    dispatch={dispatch}
                    pending={pendingEdge}
                    drag={pendingDrag}
                    selectedEdgeId={selectedEdgeId}
                    onSelectEdge={selectEdge}
                    onDeleteEdge={deleteEdge}
                    modelModalities={modelModalities}
                    modelReasoning={modelReasoning}
                    issuesByNode={issuesByNode}
                    onPortPointerDown={startEdgeDrag}
                    onOpenPicker={openPicker}
                    onOpenCron={openCron}
                    onOpenTools={openTools}
                    onOpenInfo={openInfo}
                    onOpenVariable={openVariable}
                    onOpenSystem={openSystem}
                />
            </div>

            {consoleLines !== null && (
                <ConsolePanel
                    lines={consoleLines}
                    height={consoleHeight}
                    onResize={setConsoleHeight}
                    onClear={() => setConsoleLines([])}
                    onClose={() => setConsoleLines(null)}
                />
            )}

            {picker && (
                <PathPicker
                    anchor={picker.anchor}
                    sample={picker.sample}
                    onPick={handlePick}
                    onClose={() => setPicker(null)}
                />
            )}

            {cronEdit && (
                <CronPopover
                    anchor={cronEdit.anchor}
                    initial={cronEdit.initial}
                    floorMinutes={cronFloorMinutes}
                    onChange={handleCronChange}
                    onClose={closeCron}
                />
            )}

            {toolsEdit &&
                (() => {
                    const node = present.nodes.find((n) => n.id === toolsEdit.nodeId);
                    const entry = node ? byKey[node.type] : undefined;
                    if (!node || !entry) return null;
                    return (
                        <ToolPickerPopover
                            anchor={toolsEdit.anchor}
                            entry={entry}
                            exclude={node.config.exclude ?? ""}
                            onChange={handleToolsChange}
                            onClose={closeTools}
                        />
                    );
                })()}

            {infoView && (
                <ChipInfoPopover
                    anchor={infoView.anchor}
                    entry={infoView.entry}
                    onClose={() => setInfoView(null)}
                />
            )}

            {systemEdit && (
                <SystemPopover
                    anchor={systemEdit.anchor}
                    initial={systemEdit.initial}
                    onChange={handleSystemChange}
                    onClose={closeSystem}
                />
            )}

            {variableModal && (
                <VariableModal target={variableModal} onClose={() => setVariableModal(null)} />
            )}

            {/* drag-spawn ghost chip following the pointer */}
            {spawn && spawnEntry && (
                <div
                    style={{ left: spawn.x + 10, top: spawn.y + 6 }}
                    className={`pointer-events-none fixed z-50 flex items-center gap-2 border border-foreground/15 border-l-2 bg-background px-2 py-1.5 font-mono text-xs ${
                        entryStyles(spawnEntry).borderL
                    }`}
                >
                    {isModelEntry(spawnEntry) ? (
                        <ModelLogo
                            slug={spawn.config?.model ?? ""}
                            name={spawn.label ?? spawnEntry.label}
                            size={16}
                        />
                    ) : (
                        <EntryIcon entry={spawnEntry} />
                    )}
                    <span>{spawn.label ?? spawnEntry.label}</span>
                </div>
            )}

            {/* transient bottom-center toast (notify) */}
            {toast && (
                <div
                    role={"status"}
                    className={
                        "pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 border border-foreground/20 bg-background px-3 py-1.5 font-mono text-xs text-foreground shadow-lg"
                    }
                >
                    {toast}
                </div>
            )}
        </div>
    );
}
