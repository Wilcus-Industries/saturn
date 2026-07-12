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
    CATEGORY_STYLES,
    type CatalogEntry,
    canConnect,
    edgesToReplace,
    missingEntry,
    type PortKind,
    type WorkflowGraph,
    type WorkflowRow,
} from "@/lib/workflow";
import { type ConsoleLine, runWorkflow } from "@/lib/interpreter";
// type-only import — compile-erased, safe in a client component
import type { OpenrouterModel } from "@/lib/openrouter.server";
import { callAgentModel, callIntegration, callMcpTool, saveWorkflow } from "./actions";
import Canvas, { type CanvasHandle } from "./canvas";
import ConsolePanel from "./console";
import type { PendingEdge } from "./edges";
import EntryIcon from "./entryIcon";
import {
    chipSize,
    EVENT_H,
    GRID,
    HEADER_H,
    isChipEntry,
    isEventEntry,
    isModelEntry,
    MODEL_D,
    NODE_W,
    nodeWidth,
} from "./geometry";
import ModelLogo from "./modelLogo";
import { graphReducer, initHistory } from "./graphReducer";
import type { OpenPickerHandler, PortPointerDownHandler } from "./node";
import PathPicker, { type PickerSample } from "./pathPicker";
import Toolbox from "./toolbox";
import Topbar from "./topbar";

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
    openrouterModels,
}: {
    workflow: WorkflowRow;
    userCatalog: CatalogEntry[];
    // null = no credits and no OpenRouter key; [] = unlocked but fetch failed
    openrouterModels: OpenrouterModel[] | null;
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
        try {
            await runWorkflow(present, byKey, {
                emit,
                callMcp: callMcpTool,
                callIntegration,
                callAgent: callAgentModel,
                onValue: (nodeId, portId, text) =>
                    samplesRef.current.set(`${nodeId}:${portId}`, text),
                signal: controller.signal,
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
                        : HEADER_H / 2;
            dispatch({
                type: "addNode",
                node: {
                    id: crypto.randomUUID(),
                    type: spawnKey,
                    x: snap(point.x - w / 2),
                    y: snap(point.y - dy),
                    // fresh object per spawn — never share a mutable config
                    config: { ...(preset ?? {}) },
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

    // Cmd/Ctrl+D: copies of the selected nodes (start excluded — the graph
    // allows only one) plus the edges running between them, offset a grid
    // cell, selected afterwards; one undo step
    const duplicateSelection = () => {
        const copyable = present.nodes.filter(
            (n) => selection.has(n.id) && n.type !== "start",
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
                if (picker) setPicker(null);
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
                cron={workflow.cron}
                dirty={dirty}
                saving={saving}
                error={error}
                onRun={runGraph}
                onStop={stopRun}
                running={running}
            />
            <div className={"flex min-h-0 flex-1"}>
                <Toolbox
                    graph={present}
                    userCatalog={userCatalog}
                    openrouterModels={openrouterModels}
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
                    onPortPointerDown={startEdgeDrag}
                    onOpenPicker={openPicker}
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

            {/* drag-spawn ghost chip following the pointer */}
            {spawn && spawnEntry && (
                <div
                    style={{ left: spawn.x + 10, top: spawn.y + 6 }}
                    className={`pointer-events-none fixed z-50 flex items-center gap-2 border border-foreground/15 border-l-2 bg-background px-2 py-1.5 font-mono text-xs ${
                        CATEGORY_STYLES[spawnEntry.category].borderL
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
