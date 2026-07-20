"use client";

import {
    type Dispatch,
    type PointerEvent as ReactPointerEvent,
    type Ref,
    type RefObject,
    type SetStateAction,
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
} from "react";
import type { CatalogEntry, WorkflowGraph, WorkflowNode } from "@/lib/workflow";
import Edges, { type PendingEdge } from "./edges";
import {
    GRID,
    isChipEntry,
    isEventEntry,
    isLiteralEntry,
    isModelEntry,
    isVariableEntry,
    nodeHeight,
    nodeWidth,
    portPosition,
} from "./geometry";
import type { GraphAction } from "./graphReducer";
import Node, {
    type OpenConfigHandler,
    type OpenCronHandler,
    type OpenPickerHandler,
    type OpenToolsHandler,
    type PortPointerDownHandler,
} from "./node";

// imperative surface for the designer (toolbox drag-spawn drops through it)
export type CanvasHandle = {
    // client coords → world coords; null when the point is outside the canvas
    clientToWorld: (clientX: number, clientY: number) => { x: number; y: number } | null;
};

type View = { x: number; y: number; zoom: number };

const CLICK_SLOP = 4; // px of movement below which a gesture counts as a click

// gesture state lives in a ref: rect and start coords are cached at
// pointerdown (never re-measured per move)
// resolve an agent node's effective model slug. Mirrors the interpreter's
// model resolution — a connected model node wins; config.model is a
// legacy-only fallback. Returns "" when a value edge feeds the model port
// from a non-model (dynamic) upstream, or no slug is set.
function resolveAgentModelSlug(graph: WorkflowGraph, node: WorkflowNode): string {
    const edge = graph.edges.find(
        (e) => e.kind === "value" && e.to.nodeId === node.id && e.to.portId === "model",
    );
    if (edge) {
        const src = graph.nodes.find((n) => n.id === edge.from.nodeId);
        if (src?.type !== "model") return ""; // dynamic upstream — slug unknown
        return (src.config.model ?? "").trim();
    }
    return (node.config.model ?? "").trim();
}

// options for the agent's "output" dynamicOptions select: the resolved
// model's output modalities. Unknown slug / non-model upstream → "".
function agentOutputOptions(
    graph: WorkflowGraph,
    node: WorkflowNode,
    modalities: Map<string, string[]>,
): string {
    const slug = resolveAgentModelSlug(graph, node);
    const mods = slug ? modalities.get(slug) : undefined;
    if (!mods) return "";
    return ["text", "image"].filter((m) => mods.includes(m)).join(",");
}

// options for the agent's "reasoning" dynamicOptions select, gated on the
// resolved model's reasoning capability. Supports reasoning → full effort
// set; known non-reasoning model → "off" only; unknown/unset slug → ""
// (locked, mirrors output).
function agentReasoningOptions(
    graph: WorkflowGraph,
    node: WorkflowNode,
    reasoning: Map<string, boolean>,
): string {
    const slug = resolveAgentModelSlug(graph, node);
    if (!slug) return "";
    const supports = reasoning.get(slug);
    if (supports === undefined) return ""; // model not in the list — capability unknown
    return supports ? "off,low,medium,high" : "off";
}

type Gesture =
    | {
          mode: "pan";
          startX: number;
          startY: number;
          viewX: number;
          viewY: number;
          moved: boolean;
          clearOnClick: boolean;
      }
    | { mode: "marquee"; rectLeft: number; rectTop: number; startWX: number; startWY: number };

export default function Canvas({
    graph,
    graphRef,
    byKey,
    selection,
    selectionRef,
    setSelection,
    dispatch,
    pending,
    modelModalities,
    modelReasoning,
    onPortPointerDown,
    onOpenPicker,
    onOpenCron,
    onOpenConfig,
    onOpenTools,
    ref,
}: {
    graph: WorkflowGraph;
    // live mirror for the memoized Node's gesture handlers
    graphRef: RefObject<WorkflowGraph>;
    // combined catalog: static + user registry + missing placeholders
    byKey: Record<string, CatalogEntry>;
    selection: Set<string>;
    selectionRef: RefObject<Set<string>>;
    setSelection: Dispatch<SetStateAction<Set<string>>>;
    dispatch: Dispatch<GraphAction>;
    pending: PendingEdge | null;
    // OpenRouter model slug → output modalities, for dynamicOptions fields
    modelModalities: Map<string, string[]>;
    // OpenRouter model slug → reasoning capability, for the reasoning select
    modelReasoning: Map<string, boolean>;
    onPortPointerDown: PortPointerDownHandler;
    onOpenPicker?: OpenPickerHandler;
    onOpenCron?: OpenCronHandler;
    onOpenConfig?: OpenConfigHandler;
    onOpenTools?: OpenToolsHandler;
    ref?: Ref<CanvasHandle>;
}) {
    const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 });
    const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(
        null,
    );
    const [panning, setPanning] = useState(false);

    const outerRef = useRef<HTMLDivElement>(null);
    const gestureRef = useRef<Gesture | null>(null);

    // mirror view into a ref so the native wheel listener and mid-gesture
    // conversions always read the live value (synced in an effect: refs must
    // not be written during render)
    const viewRef = useRef(view);
    useEffect(() => {
        viewRef.current = view;
    }, [view]);

    // center the graph in the viewport, zoomed to fit (never above 1:1);
    // runs once on mount so an off-origin graph isn't an empty first screen
    const fitView = () => {
        const el = outerRef.current;
        if (!el || graph.nodes.length === 0) return;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const n of graph.nodes) {
            const entry = byKey[n.type];
            if (!entry) continue;
            minX = Math.min(minX, n.x);
            minY = Math.min(minY, n.y);
            maxX = Math.max(maxX, n.x + nodeWidth(entry, n));
            maxY = Math.max(maxY, n.y + nodeHeight(entry, n));
        }
        if (minX === Infinity) return;
        const rect = el.getBoundingClientRect();
        const pad = 48;
        const zoom = Math.min(
            1,
            Math.max(
                0.25,
                Math.min(
                    (rect.width - pad * 2) / (maxX - minX),
                    (rect.height - pad * 2) / (maxY - minY),
                ),
            ),
        );
        setView({
            x: (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom,
            y: (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom,
            zoom,
        });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fit only the initial graph
    useEffect(fitView, []);

    useImperativeHandle(
        ref,
        () => ({
            clientToWorld(clientX, clientY) {
                const el = outerRef.current;
                if (!el) return null;
                const r = el.getBoundingClientRect();
                if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) {
                    return null;
                }
                const v = viewRef.current;
                return {
                    x: (clientX - r.left - v.x) / v.zoom,
                    y: (clientY - r.top - v.y) / v.zoom,
                };
            },
        }),
        [],
    );

    // zoom-to-cursor. Native listener with { passive: false } — React's
    // onWheel is passive so preventDefault (blocking page scroll) wouldn't work.
    useEffect(() => {
        const el = outerRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            const px = e.clientX - rect.left;
            const py = e.clientY - rect.top;
            // pinch arrives as wheel+ctrlKey with small deltas — stronger factor
            const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.001));
            setView((v) => {
                const zoom = Math.min(2, Math.max(0.25, v.zoom * factor));
                // keep the world point under the cursor fixed
                return {
                    x: px - ((px - v.x) / v.zoom) * zoom,
                    y: py - ((py - v.y) / v.zoom) * zoom,
                    zoom,
                };
            });
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, []);

    // only empty-canvas pointerdowns arrive here for button 0 (nodes, ports and
    // config inputs stopPropagation); middle button bubbles from anywhere
    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        const outer = outerRef.current;
        if (!outer || gestureRef.current) return;
        const v = viewRef.current;
        if (e.button === 0 && e.shiftKey) {
            const rect = outer.getBoundingClientRect();
            const wx = (e.clientX - rect.left - v.x) / v.zoom;
            const wy = (e.clientY - rect.top - v.y) / v.zoom;
            gestureRef.current = {
                mode: "marquee",
                rectLeft: rect.left,
                rectTop: rect.top,
                startWX: wx,
                startWY: wy,
            };
            setMarquee({ x: wx, y: wy, w: 0, h: 0 });
        } else if (e.button === 0 || e.button === 1) {
            e.preventDefault();
            gestureRef.current = {
                mode: "pan",
                startX: e.clientX,
                startY: e.clientY,
                viewX: v.x,
                viewY: v.y,
                moved: false,
                clearOnClick: e.button === 0,
            };
            setPanning(true);
        } else {
            return;
        }
        outer.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        const g = gestureRef.current;
        if (!g) return;
        if (g.mode === "pan") {
            const dx = e.clientX - g.startX;
            const dy = e.clientY - g.startY;
            if (!g.moved && Math.hypot(dx, dy) > CLICK_SLOP) g.moved = true;
            if (g.moved) setView((v) => ({ ...v, x: g.viewX + dx, y: g.viewY + dy }));
        } else {
            const v = viewRef.current;
            const wx = (e.clientX - g.rectLeft - v.x) / v.zoom;
            const wy = (e.clientY - g.rectTop - v.y) / v.zoom;
            setMarquee({
                x: Math.min(g.startWX, wx),
                y: Math.min(g.startWY, wy),
                w: Math.abs(wx - g.startWX),
                h: Math.abs(wy - g.startWY),
            });
        }
    };

    // pointercancel takes the same path as pointerup, minus click/select effects
    const finish = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
        const g = gestureRef.current;
        if (!g) return;
        gestureRef.current = null;
        setPanning(false);
        if (g.mode === "marquee") {
            setMarquee(null);
            if (cancelled) return;
            // recompute the final rect from the event itself (marquee state can
            // lag a frame behind the last pointermove)
            const v = viewRef.current;
            const wx = (e.clientX - g.rectLeft - v.x) / v.zoom;
            const wy = (e.clientY - g.rectTop - v.y) / v.zoom;
            const mx = Math.min(g.startWX, wx);
            const my = Math.min(g.startWY, wy);
            const mw = Math.abs(wx - g.startWX);
            const mh = Math.abs(wy - g.startWY);
            const hit = graph.nodes
                .filter((n) => {
                    const entry = byKey[n.type];
                    if (!entry) return false;
                    return (
                        n.x < mx + mw &&
                        n.x + nodeWidth(entry, n) > mx &&
                        n.y < my + mh &&
                        n.y + nodeHeight(entry, n) > my
                    );
                })
                .map((n) => n.id);
            // marquee starts with shift held, so it always adds to the selection
            if (hit.length) setSelection((prev) => new Set([...prev, ...hit]));
        } else if (!cancelled && !g.moved && g.clearOnClick) {
            // click on empty canvas (no drag) clears the selection
            setSelection(new Set());
        }
    };

    // connected value inputs, for the per-node overridden-config lookup
    const valueTargets = new Set(
        graph.edges
            .filter((e) => e.kind === "value")
            .map((e) => `${e.to.nodeId}:${e.to.portId}`),
    );

    return (
        <div
            ref={outerRef}
            className={"relative h-full flex-1 overflow-hidden touch-none select-none"}
            style={{
                backgroundImage:
                    "radial-gradient(circle, color-mix(in srgb, var(--foreground) 12%, transparent) 1px, transparent 1px)",
                backgroundSize: `${GRID * view.zoom}px ${GRID * view.zoom}px`,
                backgroundPosition: `${view.x}px ${view.y}px`,
                cursor: panning ? "grabbing" : undefined,
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={(e) => finish(e, false)}
            onPointerCancel={(e) => finish(e, true)}
        >
            <div
                className={"absolute left-0 top-0"}
                style={{
                    transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
                    transformOrigin: "0 0",
                }}
            >
                {/* edges render under the nodes */}
                <Edges graph={graph} byKey={byKey} pending={pending} dispatch={dispatch} />
                {graph.nodes.map((node) => {
                    const entry = byKey[node.type];
                    if (!entry) return null;
                    // config fields whose port is connected (dimmed as
                    // overridden); a joined string so Node's memo can compare
                    const overriddenIds =
                        entry.config
                            ?.filter(
                                (f) =>
                                    f.overriddenBy !== undefined &&
                                    valueTargets.has(`${node.id}:${f.overriddenBy}`),
                            )
                            .map((f) => f.id)
                            .join(",") ?? "";
                    const outputOptions = entry.config?.some(
                        (f) => f.id === "output" && f.dynamicOptions,
                    )
                        ? agentOutputOptions(graph, node, modelModalities)
                        : "";
                    const reasoningOptions = entry.config?.some(
                        (f) => f.id === "reasoning" && f.dynamicOptions,
                    )
                        ? agentReasoningOptions(graph, node, modelReasoning)
                        : "";
                    // chip/model output anchor, rotated toward the agent it
                    // feeds — a "lx,ly" local offset so Node's memo can compare
                    // it as a string (matches the edge anchor from geometry).
                    // Event circles pivot their flow/payload outputs, so they
                    // carry a "portId=lx,ly;…" map instead of a single pair.
                    let outAnchor = "";
                    if (
                        isModelEntry(entry) ||
                        isChipEntry(entry) ||
                        isLiteralEntry(entry) ||
                        isVariableEntry(entry)
                    ) {
                        const out = entry.outputs[0];
                        if (out) {
                            const p = portPosition(node, entry, out.id, graph, byKey);
                            outAnchor = `${p.x - node.x},${p.y - node.y}`;
                        }
                    } else if (isEventEntry(entry)) {
                        outAnchor = [...entry.inputs, ...entry.outputs]
                            .map((p) => {
                                const pos = portPosition(node, entry, p.id, graph, byKey);
                                return `${p.id}=${pos.x - node.x},${pos.y - node.y}`;
                            })
                            .join(";");
                    }
                    return (
                        <Node
                            key={node.id}
                            node={node}
                            entry={entry}
                            byKey={byKey}
                            graphRef={graphRef}
                            selected={selection.has(node.id)}
                            selectionRef={selectionRef}
                            setSelection={setSelection}
                            dispatch={dispatch}
                            zoom={view.zoom}
                            overriddenIds={overriddenIds}
                            outputOptions={outputOptions}
                            reasoningOptions={reasoningOptions}
                            outAnchor={outAnchor}
                            pendingKind={
                                pending && pending.from.nodeId !== node.id ? pending.kind : null
                            }
                            onPortPointerDown={onPortPointerDown}
                            onOpenPicker={onOpenPicker}
                            onOpenCron={onOpenCron}
                            onOpenConfig={onOpenConfig}
                            onOpenTools={onOpenTools}
                        />
                    );
                })}
                {marquee && (
                    <div
                        className={"absolute border border-foreground/40 bg-foreground/5"}
                        style={{
                            left: marquee.x,
                            top: marquee.y,
                            width: marquee.w,
                            height: marquee.h,
                        }}
                    />
                )}
            </div>
            {graph.nodes.length === 0 && (
                <p
                    className={
                        "pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-sm text-gray-400"
                    }
                >
                    drag nodes from the toolbox · drag to pan · shift+drag to select
                </p>
            )}
            {graph.nodes.length > 0 && (
                <button
                    type={"button"}
                    onClick={fitView}
                    onPointerDown={(e) => e.stopPropagation()}
                    title={"zoom to fit"}
                    className={`absolute bottom-2 right-2 border border-foreground/15 bg-background
                        px-2 py-0.5 font-mono text-xs text-gray-400 transition-colors
                        hover:text-foreground`}
                >
                    ⛶ fit
                </button>
            )}
        </div>
    );
}
