"use client";

import {
    useCallback,
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
    defaultNodeConfig,
    edgesToReplace,
    entryStyles,
    missingEntry,
    type PortKind,
    type WorkflowGraph,
    type WorkflowNode,
    type WorkflowRow,
} from "@/lib/workflow";
import { type ConsoleLine, runWorkflow } from "@/lib/interpreter";
import { sampleEventPayload } from "@/lib/integrations";
// type-only import — compile-erased, safe in a client component
import type { OpenrouterModel } from "@/lib/openrouter.server";
import { callAgentModel, callIntegration, callMcpTool, callMemoryTool, saveWorkflow } from "./actions";
import Canvas, { type CanvasHandle } from "./canvas";
import ConsolePanel from "./console";
import type { PendingEdge } from "./edges";
import EntryIcon from "./entryIcon";
import {
    anchorOffsetY,
    chipSize,
    EVENT_H,
    GRID,
    HEADER_H,
    IF_H,
    isChipEntry,
    isEventEntry,
    isIfEntry,
    isModelEntry,
    MODEL_D,
    NODE_W,
    nodeWidth,
} from "./geometry";
import ModelLogo from "./modelLogo";
import { graphReducer, initHistory } from "./graphReducer";
import type {
    OpenConfigHandler,
    OpenCronHandler,
    OpenPickerHandler,
    OpenToolsHandler,
    PortPointerDownHandler,
} from "./node";
import CronPopover from "./cronPopover";
import ConfigPopover from "./configPopover";
import ToolPickerPopover from "./toolPickerPopover";
import { describeCron } from "@/lib/cron";
import PathPicker, { type PickerSample } from "./pathPicker";
import Toolbox from "./toolbox";
import Topbar from "./topbar";
import type { VariableRow } from "./variableModal";

// don't JSON.parse arbitrarily huge samples for the path picker
const MAX_SAMPLE_CHARS = 500_000;

// an in-flight port drag; from/kind/dir are fixed at pointerdown, the live
// pointer position lives in separate state so this object stays stable
type PendingDrag = {
    from: { nodeId: string; portId: string };
    kind: PortKind;
    dir: "in" | "out";
};

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

    // selection lives outside history so undo/redo doesn't thrash it
    const [selection, setSelection] = useState<Set<string>>(new Set());

    // saved snapshot as state (not a ref) so a successful save re-renders
    // the dirty indicator immediately
    const [savedJson, setSavedJson] = useState(() => JSON.stringify(workflow.graph));
    const dirty = useMemo(() => JSON.stringify(present) !== savedJson, [present, savedJson]);

    const [error, setError] = useState<string | null>(null);

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
            const point = canvasRef.current?.clientToWorld(e.clientX, e.clientY);
            if (!point || !spawnKey) return; // dropped outside the canvas — cancel
            // one event node per workflow — the toolbox chip is already disabled
            // when one exists; this guards any other drop path
            if (byKey[spawnKey]?.category === "events" && events.length > 0) return;
            // same grid as the canvas dots and drag-end snapping
            const snap = (value: number) => Math.round(value / GRID) * GRID;
            // rectangles drop with the header centered under the pointer;
            // model circles / event blocks / grant chips center the block itself
            const entry = byKey[spawnKey];
            const w = entry ? nodeWidth(entry) : NODE_W;
            const dy =
                entry && isModelEntry(entry)
                    ? MODEL_D / 2
                    : entry && isEventEntry(entry)
                      ? EVENT_H / 2
                      : entry && isChipEntry(entry)
                        ? chipSize(entry) / 2
                        : entry && isIfEntry(entry)
                          ? IF_H / 2
                          : HEADER_H / 2;
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
            if (!target) return; // empty drop — cancel silently
            const { nodeId, portId, kind, dir } = target.dataset;
            if (!nodeId || !portId) return;
            if (kind !== pendingDrag.kind) return; // flow↔value never connects
            if ((dir !== "in" && dir !== "out") || dir === pendingDrag.dir) return;
            // drags may start from an input port — the stored edge is always out→in
            const drop = { nodeId, portId };
            const [from, to] =
                pendingDrag.dir === "out" ? [pendingDrag.from, drop] : [drop, pendingDrag.from];
            if (!canConnect(present, from, to, byKey)) return;
            dispatch({
                type: "addEdge",
                edge: { id: crypto.randomUUID(), from, to, kind: pendingDrag.kind },
                // the value-input single-edge limit replaces the old edge
                // atomically — one history entry for the whole swap (flow
                // outputs fan out; await "values" is multi-edge)
                replacing: edgesToReplace(present, from, to, byKey),
            });
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
        const valueInput = entry?.inputs.find((p) => p.kind === "value");
        const edge = valueInput
            ? graph.edges.find(
                  (e) =>
                      e.kind === "value" &&
                      e.to.nodeId === nodeId &&
                      e.to.portId === valueInput.id,
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

    // event-node config popover: same before/commit undo coalescing as
    // the cron popover — one undo step for the whole editing session
    const [configEdit, setConfigEdit] = useState<{
        nodeId: string;
        anchor: { x: number; y: number };
        before: WorkflowGraph;
    } | null>(null);

    const openConfig: OpenConfigHandler = useCallback((anchor, nodeId) => {
        setConfigEdit({ nodeId, anchor, before: graphRef.current });
    }, []);

    const handleConfigChange = (field: string, value: string) => {
        setConfigEdit((cur) => {
            if (cur) dispatch({ type: "setConfig", nodeId: cur.nodeId, field, value });
            return cur;
        });
    };
    const closeConfig = () => {
        if (configEdit) dispatch({ type: "commitConfig", before: configEdit.before });
        setConfigEdit(null);
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
    useEffect(() => {
        // eslint-disable-next-line react-hooks/immutability -- deliberate live-mirror refs, written in an effect (never during render)
        graphRef.current = present;
        savedJsonRef.current = savedJson;
        // eslint-disable-next-line react-hooks/immutability -- see above
        byKeyRef.current = byKey;
        selectionRef.current = selection;
    });

    // flush on unmount: in-app navigation (e.g. "← workflows") doesn't fire
    // beforeunload, and edits inside the debounce window would be lost.
    // Fire-and-forget — the SPA stays alive across client-side navigation.
    useEffect(() => {
        return () => {
            if (JSON.stringify(graphRef.current) !== savedJsonRef.current) {
                saveWorkflow(workflow.id, graphRef.current).catch(() => {});
            }
        };
    }, [workflow.id]);

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
        setSelection(new Set(nodes.map((n) => n.id)));
    };

    // one window keydown handler; re-attached each render so it always sees
    // fresh state (cheap, avoids a ref dance)
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            const key = e.key.toLowerCase();
            const mod = e.metaKey || e.ctrlKey;
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
                if (selection.size) dispatch({ type: "deleteNodes", ids: [...selection] });
            } else if (mod && key === "z") {
                e.preventDefault();
                dispatch({ type: e.shiftKey ? "redo" : "undo" });
            } else if (mod && key === "y") {
                e.preventDefault();
                dispatch({ type: "redo" });
            } else if (mod && key === "a") {
                e.preventDefault();
                setSelection(new Set(present.nodes.map((n) => n.id)));
            } else if (mod && key === "d") {
                e.preventDefault();
                duplicateSelection();
            } else if (e.key.startsWith("Arrow") && selection.size) {
                // nudge the selection one grid cell; each press is an undo step
                e.preventDefault();
                const dx = e.key === "ArrowLeft" ? -GRID : e.key === "ArrowRight" ? GRID : 0;
                const dy = e.key === "ArrowUp" ? -GRID : e.key === "ArrowDown" ? GRID : 0;
                const before = present;
                dispatch({ type: "moveNodes", ids: [...selection], dx, dy });
                dispatch({ type: "commitDrag", before });
            } else if (e.key === "Escape") {
                if (cronEdit) closeCron();
                else if (configEdit) closeConfig();
                else if (toolsEdit) closeTools();
                else if (picker) setPicker(null);
                else if (pendingDrag) {
                    setPendingDrag(null);
                    setPendingPoint(null);
                } else if (spawn) setSpawn(null);
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
                />
                <Canvas
                    ref={canvasRef}
                    graph={present}
                    graphRef={graphRef}
                    byKey={byKey}
                    selection={selection}
                    selectionRef={selectionRef}
                    setSelection={setSelection}
                    dispatch={dispatch}
                    pending={pendingEdge}
                    modelModalities={modelModalities}
                    modelReasoning={modelReasoning}
                    onPortPointerDown={startEdgeDrag}
                    onOpenPicker={openPicker}
                    onOpenCron={openCron}
                    onOpenConfig={openConfig}
                    onOpenTools={openTools}
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

            {configEdit &&
                (() => {
                    const node = present.nodes.find((n) => n.id === configEdit.nodeId);
                    const entry = node ? byKey[node.type] : undefined;
                    if (!node || !entry) return null;
                    // config fields whose value port is connected — dimmed as
                    // overridden (mirrors the canvas's per-node computation)
                    const valueTargets = new Set(
                        present.edges
                            .filter((e) => e.kind === "value")
                            .map((e) => `${e.to.nodeId}:${e.to.portId}`),
                    );
                    const overriddenIds =
                        entry.config
                            ?.filter(
                                (f) =>
                                    f.overriddenBy !== undefined &&
                                    valueTargets.has(`${node.id}:${f.overriddenBy}`),
                            )
                            .map((f) => f.id)
                            .join(",") ?? "";
                    return (
                        <ConfigPopover
                            anchor={configEdit.anchor}
                            entry={entry}
                            config={node.config}
                            overriddenIds={overriddenIds}
                            onChange={handleConfigChange}
                            onClose={closeConfig}
                        />
                    );
                })()}

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
        </div>
    );
}
