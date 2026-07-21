"use client";

import {
    type Dispatch,
    memo,
    type PointerEvent as ReactPointerEvent,
    type RefObject,
    type SetStateAction,
    useRef,
} from "react";
import { FaTerminal } from "react-icons/fa6";
import {
    type CatalogEntry,
    type ConfigField,
    entryStyles,
    MODEL_PRESET,
    type PortKind,
    type PortSpec,
    type WorkflowGraph,
    type WorkflowNode,
} from "@/lib/workflow";
import { describeCron } from "@/lib/cron";
import McpLogo from "@/app/dashboard/mcpLogo";
import ConfigControl from "./configControl";
import EntryBadge from "./entryBadge";
import EntryIcon from "./entryIcon";
import IssueDot from "./issueDot";
import NodeFrame from "./nodeFrame";
import {
    AGENT_BODY_H,
    AGENT_CONFIG_H,
    AGENT_HEADER_H,
    AGENT_LABEL_H,
    AGENT_LEFT_GUTTER,
    AGENT_PORT_H,
    AGENT_PORT_SLOT,
    AGENT_RIGHT_GUTTER,
    anchorOffsetY,
    GRID,
    EVENT_H,
    EVENT_LABEL_W,
    EVENT_W,
    HEADER_H,
    IF_BODY_H,
    IF_HEADER_H,
    IF_W,
    isAgentEntry,
    isEventEntry,
    isIfEntry,
    isLiteralEntry,
    isMcpChipEntry,
    isMemoryChipEntry,
    isModelEntry,
    isSandboxChipEntry,
    isSkillChipEntry,
    isVariableEntry,
    MCP_CHIP,
    MEMORY_CHIP,
    MODEL_D,
    nodeHeight,
    nodeWidth,
    SANDBOX_CHIP,
    SKILL_CHIP,
    unpairedInputs,
} from "./geometry";
import type { GraphAction } from "./graphReducer";
import ModelLogo from "./modelLogo";

// generic single-io labels ("in"/"out") add no signal over the port marker
// (◆/○) and its side, so they're hidden — named ports (a/b/prompt/true…) stay
const isGenericLabel = (label: string) => label === "in" || label === "out";

// a press on a port starts an edge drag (owned by the designer); the port
// button takes pointer capture so the drop is resolved via elementFromPoint
export type PortPointerDownHandler = (
    e: ReactPointerEvent<HTMLButtonElement>,
    nodeId: string,
    portId: string,
    kind: PortKind,
    dir: "in" | "out",
) => void;

// a config field flagged picker: "json-path" gets a button that opens the
// designer's sample popover; the anchor is the button's client-space corner
export type OpenPickerHandler = (
    anchor: { x: number; y: number },
    nodeId: string,
    fieldId: string,
) => void;

// a schedule event node opens the cron popover when clicked (press with no
// drag); the anchor is the node's client-space bottom-left corner
export type OpenCronHandler = (
    anchor: { x: number; y: number },
    nodeId: string,
) => void;

// an mcp server chip opens the tool picker popover when clicked (press with
// no drag); the anchor is the node's client-space bottom-left corner, like cron
export type OpenToolsHandler = (
    anchor: { x: number; y: number },
    nodeId: string,
) => void;

// a skill/memory grant chip opens a read-only info popover when clicked (press
// with no drag); the anchor is the node's client-space bottom-left corner, like
// the tool picker
export type OpenInfoHandler = (
    anchor: { x: number; y: number },
    nodeId: string,
) => void;

// a secret-variable value box opens its edit modal when clicked (press with no
// drag); the modal is centered, so it takes just the node id (no anchor)
export type OpenVariableHandler = (nodeId: string) => void;

// an agent node's "system" button opens the system-prompt popover when clicked;
// the anchor is the button's client-space bottom-left corner, like the cron
// popover opener
export type OpenSystemHandler = (
    anchor: { x: number; y: number },
    nodeId: string,
) => void;

// renders to the geometry.ts metrics exactly: w-44 = NODE_W 176, the header
// band's height comes straight from HEADER_H, h-6 port rows = PORT_ROW_H 24,
// h-9 config rows =
// CONFIG_ROW_H 36 (h-[72px] textarea rows = TEXTAREA_ROW_H 72), pb-1 = 4px
// bottom pad. Model nodes render circular: MODEL_D 54 plus an
// h-6 name strip = MODEL_LABEL_H 24. Input-less event nodes (schedule) render
// circular too: h-12 w-12 = EVENT_H 48 × EVENT_W 48 plus an h-6 label strip =
// EVENT_LABEL_H 24. Change sizes only via geometry.ts. Frames come from NodeFrame (an inset
// overlay) — a real `border` on a node box would shift its ports off those
// metrics; see nodeFrame.tsx.

const DRAG_SLOP = 4; // client px below which a press counts as a click

type DragState = {
    ids: string[];
    before: WorkflowGraph; // pre-drag snapshot for the single undo step
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    active: boolean;
};

// memoized: during a drag only the moved nodes get new `node` objects, so
// the rest of the graph skips re-rendering. Anything read mid-gesture
// (graph snapshot, current selection) comes through stable refs instead of
// per-render props — keep it that way or the memo dies.
export default memo(function Node({
    node,
    entry,
    byKey,
    graphRef,
    selected,
    selectionRef,
    setSelection,
    dispatch,
    zoom,
    overriddenIds,
    outputOptions,
    reasoningOptions,
    outAnchor,
    connectable,
    issueLevel,
    onPortPointerDown,
    onOpenPicker,
    onOpenCron,
    onOpenTools,
    onOpenInfo,
    onOpenVariable,
    onOpenSystem,
}: {
    node: WorkflowNode;
    entry: CatalogEntry;
    // combined catalog — resolves each dragged node's entry at drag-end so its
    // primary port axis (not the top-left corner) settles onto the grid; a
    // stable useMemo reference, so it doesn't defeat this component's memo
    byKey: Record<string, CatalogEntry>;
    graphRef: RefObject<WorkflowGraph>;
    selected: boolean;
    selectionRef: RefObject<Set<string>>;
    setSelection: Dispatch<SetStateAction<Set<string>>>;
    dispatch: Dispatch<GraphAction>;
    zoom: number;
    // comma-joined config field ids currently overridden by a connected
    // port (computed by the canvas so this memo prop is a comparable string)
    overriddenIds: string;
    // comma-joined options for a dynamicOptions select (the agent output
    // field) — "" means the resolved model's modalities are unknown, so
    // nothing is selectable. Same canvas-computed-string pattern as above.
    outputOptions: string;
    // comma-joined options for the agent's reasoning dynamicOptions select —
    // "" means the resolved model's reasoning capability is unknown (locked).
    reasoningOptions: string;
    // "lx,ly" local offset of a chip/model node's rotated output port (empty
    // for every other node) — computed by the canvas from geometry so it
    // matches the edge anchor and Node's memo can compare it as a string
    outAnchor: string;
    // honest port-drop affordance during an edge drag (comparable string so
    // Node's memo survives; computed once per drag by the canvas from the fixed
    // drag origin via canConnect, NOT from the moving pointer):
    //   ""  — no drag in progress: every port renders normally
    //   "-" — drag active but nothing on this node is a legal target: dim all
    //         this node's ports
    //   "a,b,…" — the comma-joined ids of the ports that ARE legal drop targets:
    //         those scale+glow, the rest of this node's ports dim
    connectable: string;
    // live validation state for THIS node, as a comparable string so the memo
    // survives: "" none / "warning" / "error". Drives the top-right IssueDot on
    // every shape branch (paint-only — never an outline, which means selection).
    issueLevel: string;
    onPortPointerDown: PortPointerDownHandler;
    onOpenPicker?: OpenPickerHandler;
    onOpenCron?: OpenCronHandler;
    onOpenTools?: OpenToolsHandler;
    onOpenInfo?: OpenInfoHandler;
    onOpenVariable?: OpenVariableHandler;
    onOpenSystem?: OpenSystemHandler;
}) {
    const styles = entryStyles(entry);
    // honest highlighting: a drag is active whenever `connectable` is non-empty;
    // the set holds only the port ids on THIS node that are legal drop targets
    // (empty/"-" → none here). Candidates are always opposite-direction ports
    // of the drag origin, so a legal id can't collide with a same-side port id.
    const dragActive = connectable !== "";
    const connectableSet =
        connectable && connectable !== "-" ? new Set(connectable.split(",")) : null;
    // local (x,y) offset of a rotated chip/model output marker; null → the
    // branch's right-edge default
    const parsedOutAnchor: [number, number] | null = outAnchor
        ? (outAnchor.split(",").map(Number) as [number, number])
        : null;
    const dragRef = useRef<DragState | null>(null);
    const configBeforeRef = useRef<WorkflowGraph | null>(null);
    // literal box: a click (press with no drag) focuses the value field so
    // the whole box is both draggable and editable — see its branch below
    const literalFieldRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

    // Escape mid-drag restores the pre-gesture positions (no history entry).
    // The handler lives in a ref: drags re-render, so removeEventListener
    // must get the same instance addEventListener got (and the same capture
    // flag — see onEscape below).
    const dragEscapeRef = useRef<((e: KeyboardEvent) => void) | null>(null);
    const removeDragEscape = () => {
        if (!dragEscapeRef.current) return;
        window.removeEventListener("keydown", dragEscapeRef.current, { capture: true });
        dragEscapeRef.current = null;
    };

    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return; // middle button bubbles up so the canvas can pan
        e.stopPropagation(); // don't start a canvas pan/marquee
        const selection = selectionRef.current;
        let ids: string[];
        if (e.shiftKey) {
            if (selection.has(node.id)) {
                const next = new Set(selection);
                next.delete(node.id);
                setSelection(next);
                return; // shift-click deselected — no drag
            }
            const next = new Set(selection).add(node.id);
            setSelection(next);
            ids = [...next];
        } else if (selection.has(node.id)) {
            ids = [...selection]; // already selected: drag the whole selection
        } else {
            setSelection(new Set([node.id]));
            ids = [node.id];
        }
        e.currentTarget.setPointerCapture(e.pointerId);
        // Escape-ordering contract: this listener runs in the CAPTURE phase, so
        // it fires before the designer's bubble-phase window Escape ladder. When
        // a drag is actually active it cancels the drag AND stopPropagation()s,
        // so the ladder doesn't ALSO clear the selection (the old double-fire).
        // When no drag is active (pointer down but not yet moved past slop) it
        // stays silent and lets the event fall through to the ladder.
        const onEscape = (ev: KeyboardEvent) => {
            if (ev.key !== "Escape") return;
            const drag = dragRef.current;
            if (drag?.active) ev.stopPropagation();
            dragRef.current = null;
            removeDragEscape();
            if (drag?.active) dispatch({ type: "cancelDrag", before: drag.before });
        };
        dragEscapeRef.current = onEscape;
        window.addEventListener("keydown", onEscape, { capture: true });
        dragRef.current = {
            ids,
            before: graphRef.current,
            startX: e.clientX,
            startY: e.clientY,
            lastX: e.clientX,
            lastY: e.clientY,
            active: false,
        };
    };

    const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag) return;
        if (!drag.active) {
            if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) <= DRAG_SLOP) return;
            drag.active = true; // first move dispatches the accumulated slop too
        }
        // client px → world units
        const dx = (e.clientX - drag.lastX) / zoom;
        const dy = (e.clientY - drag.lastY) / zoom;
        drag.lastX = e.clientX;
        drag.lastY = e.clientY;
        if (dx !== 0 || dy !== 0) dispatch({ type: "moveNodes", ids: drag.ids, dx, dy });
    };

    // pointercancel ends the drag like pointerup; commitDrag no-ops when the
    // graph didn't actually change
    const endDrag = () => {
        removeDragEscape();
        const drag = dragRef.current;
        dragRef.current = null;
        if (!drag?.active) return;
        // settle each dragged node onto the grid, then record one undo step.
        // x snaps the left edge; y snaps the node's primary port axis (node.y +
        // anchorOffsetY) so differently-shaped nodes left at the same level get
        // their ports on the same grid line and edges between them stay flat.
        for (const id of drag.ids) {
            const n = graphRef.current.nodes.find((candidate) => candidate.id === id);
            if (!n) continue;
            const off = byKey[n.type] ? anchorOffsetY(byKey[n.type], n) : HEADER_H / 2;
            const dx = Math.round(n.x / GRID) * GRID - n.x;
            const dy = Math.round((n.y + off) / GRID) * GRID - off - n.y;
            if (dx || dy) dispatch({ type: "moveNodes", ids: [id], dx, dy });
        }
        dispatch({ type: "commitDrag", before: drag.before });
    };

    // config edits are transient (setConfig) and coalesce into one undo step:
    // stash the graph on focus, commit it on blur
    const onConfigFocus = () => {
        configBeforeRef.current = graphRef.current;
    };
    const onConfigBlur = () => {
        const before = configBeforeRef.current;
        configBeforeRef.current = null;
        if (before) dispatch({ type: "commitConfig", before });
    };

    // stopPropagation keeps a port press from starting a node drag; the
    // designer owns the edge drag from here on (middle button still bubbles
    // so the canvas can pan)
    const port = (
        spec: PortSpec,
        dir: "in" | "out",
        // rectangular rows straddle the node edge via a negative margin; the
        // circular model branch positions the port itself and passes ""
        marginClass = dir === "in" ? "-ml-1.5" : "-mr-1.5",
    ) => {
        // honest highlighting: only legal drop targets scale + glow; during a
        // drag every other port on this node dims (opacity-40). No drag → normal.
        const portConnectable = dragActive && !!connectableSet?.has(spec.id);
        const portDimmed = dragActive && !portConnectable;
        return (
        <button
            type={"button"}
            data-port={"true"}
            data-node-id={node.id}
            data-port-id={spec.id}
            data-kind={spec.kind}
            data-dir={dir}
            onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                e.currentTarget.setPointerCapture(e.pointerId);
                onPortPointerDown(e, node.id, spec.id, spec.kind, dir);
            }}
            className={`relative flex shrink-0 cursor-crosshair items-center justify-center text-[10px] leading-none transition-[transform,opacity] ${marginClass} ${
                spec.kind === "flow" ? "text-foreground" : styles.text
            } ${
                portConnectable
                    ? "scale-125 drop-shadow-[0_0_3px_currentColor]"
                    : portDimmed
                      ? "opacity-40"
                      : ""
            }`}
        >
            {/* invisible fat hit target inside the button (parity with edges'
                12px fat twin): ~26px wide / ~14px tall so a ~10px glyph is
                comfortably clickable. Vertical inset is deliberately small —
                if-node inputs (l/in/r) sit only 16px apart, so a taller overlay
                would cross the midline into the neighbouring port. data-port
                stays on the button, so elementFromPoint().closest("[data-port]")
                resolves a hit on this span to the button either way. */}
            <span aria-hidden className={"absolute -inset-x-2 -inset-y-0.5"} />
            {/* flow ports are a filled diamond (a 45°-tilted square), value
                ports a hollow circle. The diamond's 7px box keeps the layout
                width of the glyph it replaced; the rotation overflows it
                visually without moving the row's other content, and both
                markers are rotation-agnostic so no branch needs to spin them. */}
            {spec.kind === "flow" ? (
                <span className={"h-[7px] w-[7px] rotate-45 bg-current"} />
            ) : (
                "○"
            )}
        </button>
        );
    };

    // model nodes render as a circle (MODEL_D 54, h-6 name strip =
    // MODEL_LABEL_H 24) — the single value output anchors on the circle's
    // right-edge midpoint per geometry.ts. Nodes spawned from a per-model
    // toolbox chip carry config.preset = MODEL_PRESET and show a read-only
    // name; without it (blank chip, legacy graphs) the slug stays editable.
    if (isModelEntry(entry)) {
        const output = entry.outputs[0];
        const readOnly = node.config.preset === MODEL_PRESET;
        const name = node.config.model || entry.label;
        // the author prefix ("openai/…") eats the narrow strip — show only
        // the model segment; the full slug stays in the title tooltip
        const shortName = name.slice(name.indexOf("/") + 1);
        return (
            <div
                data-node-id={node.id}
                style={{ left: node.x, top: node.y, width: MODEL_D }}
                // selection outline rides the outer wrapper (circle + name
                // strip), matching the agent/if/generic branches
                className={`absolute font-mono text-xs ${
                    selected ? "outline outline-1 outline-foreground" : ""
                }`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
            >
                <IssueDot level={issueLevel} />
                <div
                    style={{ width: MODEL_D, height: MODEL_D }}
                    // rose category frame (entryStyles) — the model circle used
                    // to be the only shape with no visible category color
                    className={`relative flex cursor-grab items-center justify-center rounded-full border ${styles.border} bg-background ${styles.headerBg}`}
                >
                    {/* logo fills the circle; clip here (not on the circle
                        div) so the edge-straddling port isn't cut off */}
                    <span
                        style={{ width: MODEL_D, height: MODEL_D }}
                        className={"flex overflow-hidden rounded-full"}
                    >
                        <ModelLogo slug={node.config.model ?? ""} name={name} size={MODEL_D} />
                    </span>
                </div>
                {/* the port hangs off the borderless outer box, so its anchor
                    is node.x/node.y exactly — inside the bordered circle it
                    would drift by the border width, off geometry.ts's anchor */}
                {output &&
                    (() => {
                        const [ax, ay] = parsedOutAnchor ?? [MODEL_D, MODEL_D / 2];
                        return (
                            <span
                                className={"absolute flex"}
                                style={{ left: ax, top: ay, transform: "translate(-50%, -50%)" }}
                            >
                                {port(output, "out", "")}
                            </span>
                        );
                    })()}
                <div
                    style={{ width: MODEL_D }}
                    className={"flex h-6 items-center justify-center"}
                >
                    {readOnly ? (
                        <span
                            // two 12px lines fill the h-6 strip exactly —
                            // MODEL_LABEL_H stays 24, geometry untouched
                            className={
                                "line-clamp-2 max-w-full break-words text-center text-[10px] leading-3"
                            }
                            title={name}
                        >
                            {shortName}
                        </span>
                    ) : (
                        <input
                            value={node.config.model ?? ""}
                            placeholder={entry.config?.[0]?.placeholder}
                            onPointerDown={(e) => e.stopPropagation()}
                            onFocus={onConfigFocus}
                            onBlur={onConfigBlur}
                            onChange={(e) =>
                                dispatch({
                                    type: "setConfig",
                                    nodeId: node.id,
                                    field: "model",
                                    value: e.target.value,
                                })
                            }
                            className={
                                "w-full min-w-0 border border-foreground/15 bg-background px-1 py-0.5 text-center font-mono text-[10px]"
                            }
                        />
                    )}
                </div>
            </div>
        );
    }

    // event circles (h-12 w-12 = EVENT_H × EVENT_W, h-6 label strip =
    // EVENT_LABEL_H) — only input-less event entries (schedule, legacy start;
    // see geometry's isEventEntry): icon centered, label underneath, a single
    // flow output anchored per geometry.ts. Platform events carry config-port
    // inputs and render as generic rectangles below. Icon: the platform
    // favicon (logoDomain), else the emoji, else the ▶ fallback.
    if (isEventEntry(entry)) {
        const flowOut = entry.outputs.find((p) => p.kind === "flow");
        // a schedule event carries a cron config field, authored via the cron
        // popover (not an inline field); the label strip shows its humanized
        // schedule so the node reads "daily at 09:00" under the clock
        const hasCron = entry.config?.some((f) => f.id === "cron");
        const cron = (node.config.cron ?? "").trim();
        const labelText = hasCron
            ? cron
                ? describeCron(cron)
                : "not scheduled"
            : entry.label;
        // a click opens the cron popover for a schedule; otherwise the node
        // just drags
        const clickOpens = hasCron;

        // a press that stayed under the drag threshold is a click → open the
        // cron popover
        const eventEndDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
            const wasClick = !!dragRef.current && !dragRef.current.active;
            endDrag();
            if (!wasClick) return;
            const r = e.currentTarget.getBoundingClientRect();
            const anchor = { x: r.left, y: r.bottom + 4 };
            if (onOpenCron) onOpenCron(anchor, node.id);
        };

        // per-port "portId=lx,ly" local anchors from the canvas (rotated toward
        // each port's connection, matching the edge anchors from geometry)
        const anchors = new Map<string, [number, number]>();
        if (outAnchor)
            for (const part of outAnchor.split(";")) {
                const [id, xy] = part.split("=");
                if (!xy) continue;
                const [x, y] = xy.split(",").map(Number);
                anchors.set(id, [x, y]);
            }
        const at = (spec: PortSpec, home: [number, number]) => {
            const [ax, ay] = anchors.get(spec.id) ?? home;
            return (
                <span
                    className={"absolute flex"}
                    style={{ left: ax, top: ay, transform: "translate(-50%, -50%)" }}
                >
                    {port(spec, "out", "")}
                </span>
            );
        };

        return (
            <div
                data-node-id={node.id}
                style={{ left: node.x, top: node.y, width: EVENT_W }}
                // selection outline rides the outer wrapper (EVENT_W wide),
                // matching agent/if/generic. Accepted quirk: the label strip
                // below is wider (EVENT_LABEL_W) than the wrapper, so multi-word
                // labels overflow the outline — the strip is render-only and
                // never anchors a port/edge, so this is purely cosmetic.
                className={`absolute font-mono text-xs ${
                    selected ? "outline outline-1 outline-foreground" : ""
                }`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={clickOpens ? eventEndDrag : endDrag}
                onPointerCancel={endDrag}
            >
                <EntryBadge />
                <IssueDot level={issueLevel} />
                <div
                    style={{ width: EVENT_W, height: EVENT_H }}
                    // category frame via entryStyles (amber for events)
                    className={`relative flex ${clickOpens ? "cursor-pointer hover:brightness-110" : "cursor-grab"} items-center justify-center rounded-full border ${styles.border} bg-background ${styles.headerBg}`}
                >
                    {entry.logoDomain ? (
                        <McpLogo domain={entry.logoDomain} name={entry.label} size={32} round />
                    ) : entry.emoji ? (
                        <span className={"text-2xl leading-none"}>{entry.emoji}</span>
                    ) : (
                        // ▶ glyph's mass leans left; nudge right to optically center
                        <span className={`translate-x-[2px] text-2xl leading-none ${styles.text}`}>
                            {"▶"}
                        </span>
                    )}
                </div>
                {/* ports on the borderless outer box — see the model branch */}
                {flowOut && at(flowOut, [EVENT_W, EVENT_H / 2])}
                {/* strip is wider than the circle (EVENT_LABEL_W, centered via
                    negative margin) so multi-word labels fit — render-only,
                    ports/edges anchor on the circle above */}
                <div
                    style={{ width: EVENT_LABEL_W, marginLeft: (EVENT_W - EVENT_LABEL_W) / 2 }}
                    className={"flex h-6 items-center justify-center"}
                >
                    <span
                        className={
                            "line-clamp-2 max-w-full break-words text-center text-[10px] leading-3"
                        }
                        title={labelText}
                    >
                        {labelText}
                    </span>
                </div>
            </div>
        );
    }

    // mcp/skill/memory/sandbox grant chips render as a rounded square (60px mcp
    // / 48px skill+memory+sandbox = MCP_CHIP/SKILL_CHIP/MEMORY_CHIP/SANDBOX_CHIP,
    // h-6 label strip = CHIP_LABEL_H) with the server favicon / skill+memory
    // emoji / sandbox terminal icon centered and a single value output on the
    // right-edge midpoint per geometry.ts, mirroring the model circle branch.
    // Border is the category color via entryStyles — purple mcp / green skill /
    // fuchsia memory / lime sandbox.
    if (
        isMcpChipEntry(entry) ||
        isSkillChipEntry(entry) ||
        isMemoryChipEntry(entry) ||
        isSandboxChipEntry(entry)
    ) {
        const output = entry.outputs[0];
        const mcp = isMcpChipEntry(entry);
        const memory = isMemoryChipEntry(entry);
        const sandbox = isSandboxChipEntry(entry);
        const size = mcp ? MCP_CHIP : memory ? MEMORY_CHIP : sandbox ? SANDBOX_CHIP : SKILL_CHIP;

        // a press that stayed under the drag threshold is a click: an mcp
        // server chip opens the tool-picker popover, a skill/memory chip opens
        // a read-only info popover (both anchored at the chip's bottom-left)
        const chipEndDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
            const wasClick = !!dragRef.current && !dragRef.current.active;
            endDrag();
            if (!wasClick) return;
            const r = e.currentTarget.getBoundingClientRect();
            const anchor = { x: r.left, y: r.bottom + 4 };
            if (mcp) onOpenTools?.(anchor, node.id);
            else onOpenInfo?.(anchor, node.id);
        };

        return (
            <div
                data-node-id={node.id}
                style={{ left: node.x, top: node.y, width: size }}
                // selection outline rides the outer wrapper (chip + label
                // strip), matching agent/if/generic
                className={`absolute font-mono text-xs ${
                    selected ? "outline outline-1 outline-foreground" : ""
                }`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={chipEndDrag}
                onPointerCancel={endDrag}
            >
                <IssueDot level={issueLevel} />
                <div
                    style={{ width: size, height: size }}
                    // category frame via entryStyles; every chip is clickable
                    // (tool picker / info), so all get the pointer + hover cue
                    className={`relative flex cursor-pointer items-center justify-center rounded-xl border-2 ${styles.border} bg-background ${styles.headerBg} hover:brightness-110`}
                >
                    {mcp ? (
                        <McpLogo domain={entry.logoDomain ?? ""} name={entry.label} size={"fill"} />
                    ) : sandbox ? (
                        <FaTerminal className={`text-2xl ${styles.text}`} />
                    ) : (
                        <span className={"text-2xl leading-none"}>{entry.emoji}</span>
                    )}
                </div>
                {/* port on the borderless outer box — see the model branch.
                    Chips carry border-2, so nesting it would skew 2px */}
                {output &&
                    (() => {
                        const [ax, ay] = parsedOutAnchor ?? [size, size / 2];
                        return (
                            <span
                                className={"absolute flex"}
                                style={{ left: ax, top: ay, transform: "translate(-50%, -50%)" }}
                            >
                                {port(output, "out", "")}
                            </span>
                        );
                    })()}
                <div className={"flex h-6 items-center justify-center"}>
                    <span
                        className={
                            "line-clamp-2 max-w-full break-words text-center text-[10px] leading-3"
                        }
                        title={entry.label}
                    >
                        {entry.label}
                    </span>
                </div>
            </div>
        );
    }

    // literal value nodes (string/number): a bare header-less box holding the
    // editable value, one value output on the right edge (geometry.ts
    // isLiteralEntry). The string box grows with its content. The whole box
    // drags; a press that never becomes a drag focuses the field, so it stays
    // editable without a separate drag handle.
    if (isLiteralEntry(entry)) {
        const output = entry.outputs[0];
        const isNumber = entry.key === "number";
        const value = node.config.value ?? "";
        const width = nodeWidth(entry, node);
        const height = nodeHeight(entry, node);

        // a press that stayed under the drag threshold is a click → focus
        const literalEndDrag = () => {
            const wasClick = !!dragRef.current && !dragRef.current.active;
            endDrag();
            if (wasClick) literalFieldRef.current?.focus();
        };
        // once focused, the field owns the pointer (caret + text selection);
        // otherwise the press bubbles to the box for drag/click-to-focus
        const fieldPointerDown = (e: ReactPointerEvent) => {
            if (document.activeElement === e.currentTarget) e.stopPropagation();
        };
        const onChange = (e: { target: { value: string } }) =>
            dispatch({ type: "setConfig", nodeId: node.id, field: "value", value: e.target.value });
        const fieldClass =
            "min-w-0 flex-1 bg-transparent leading-[18px] text-foreground outline-none placeholder:text-gray-500";

        return (
            <div
                data-node-id={node.id}
                style={{ left: node.x, top: node.y, width }}
                // selection outline rides the outer wrapper, matching every
                // other shape
                className={`absolute font-mono text-xs ${
                    selected ? "outline outline-1 outline-foreground" : ""
                }`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={literalEndDrag}
                onPointerCancel={endDrag}
            >
                <IssueDot level={issueLevel} />
                <div
                    style={{ height }}
                    // string/number are bare value boxes, not category members,
                    // so they deliberately keep a neutral frame — the only shape
                    // whose border is NOT entryStyles(entry).border
                    className={"relative flex cursor-grab items-stretch rounded border border-foreground/25 bg-background px-2 py-1.5"}
                >
                    {isNumber ? (
                        <input
                            ref={(el) => {
                                literalFieldRef.current = el;
                            }}
                            type={"number"}
                            value={value}
                            placeholder={"0"}
                            onPointerDown={fieldPointerDown}
                            onFocus={onConfigFocus}
                            onBlur={onConfigBlur}
                            onChange={onChange}
                            // hide the native spin buttons — keep it a bare box
                            className={`${fieldClass} [appearance:textfield] [&::-webkit-inner-spin-button]:[appearance:none] [&::-webkit-outer-spin-button]:[appearance:none]`}
                        />
                    ) : (
                        <textarea
                            ref={(el) => {
                                literalFieldRef.current = el;
                            }}
                            value={value}
                            wrap={"off"}
                            maxLength={4000}
                            placeholder={"value"}
                            onPointerDown={fieldPointerDown}
                            onFocus={onConfigFocus}
                            onBlur={onConfigBlur}
                            onChange={onChange}
                            className={`${fieldClass} resize-none overflow-hidden whitespace-pre`}
                        />
                    )}
                </div>
                {/* port on the borderless outer box — see the model branch */}
                {output &&
                    (() => {
                        const [ax, ay] = parsedOutAnchor ?? [width, height / 2];
                        return (
                            <span
                                className={"absolute flex"}
                                style={{ left: ax, top: ay, transform: "translate(-50%, -50%)" }}
                            >
                                {port(output, "out", "")}
                            </span>
                        );
                    })()}
            </div>
        );
    }

    // secret variable nodes: a read-only literal-shaped box showing only the
    // variable's name behind a key glyph (the value never reaches the client —
    // the node evaluates to an opaque {{var:<uuid>}} sentinel). Violet category
    // frame via entryStyles. Clicking opens the variable's edit modal.
    if (isVariableEntry(entry)) {
        const output = entry.outputs[0];
        const width = nodeWidth(entry, node);
        const height = nodeHeight(entry, node);

        // a press that stayed under the drag threshold is a click → open the
        // variable's edit modal (the toolbox's VariableModal, lifted to the
        // designer, which resolves the row by uuid from the node type)
        const variableEndDrag = () => {
            const wasClick = !!dragRef.current && !dragRef.current.active;
            endDrag();
            if (wasClick) onOpenVariable?.(node.id);
        };
        return (
            <div
                data-node-id={node.id}
                style={{ left: node.x, top: node.y, width }}
                // selection outline rides the outer wrapper, matching every
                // other shape
                className={`absolute font-mono text-xs ${
                    selected ? "outline outline-1 outline-foreground" : ""
                }`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={variableEndDrag}
                onPointerCancel={endDrag}
            >
                <IssueDot level={issueLevel} />
                <div
                    style={{ height }}
                    className={`relative flex cursor-pointer items-center gap-1.5 overflow-hidden rounded border ${styles.border} bg-background px-2 py-1.5 hover:brightness-110`}
                    title={entry.label}
                >
                    <span aria-hidden className={"leading-[18px] text-violet-600 dark:text-violet-400"}>
                        ⚿
                    </span>
                    <span className={"truncate leading-[18px]"}>{entry.label}</span>
                </div>
                {/* port on the borderless outer box — see the model branch */}
                {output &&
                    (() => {
                        const [ax, ay] = parsedOutAnchor ?? [width, height / 2];
                        return (
                            <span
                                className={"absolute flex"}
                                style={{ left: ax, top: ay, transform: "translate(-50%, -50%)" }}
                            >
                                {port(output, "out", "")}
                            </span>
                        );
                    })()}
            </div>
        );
    }

    // agent nodes render horizontally: a header, the output + reasoning
    // dropdowns in a row, the value inputs laid along the BOTTOM edge (name
    // centered above each marker), the flow "in" on the LEFT edge, and the
    // outputs "out"/"result" stacked on the RIGHT edge (geometry.ts
    // isAgentEntry — the side ports are absolutely positioned to match).
    if (isAgentEntry(entry)) {
        const bottomPorts = entry.inputs.filter((p) => p.kind !== "flow");
        const flowInput = entry.inputs.find((p) => p.kind === "flow");
        const width = nodeWidth(entry);
        // a config field whose port is connected dims + locks (same as the
        // generic branch) — only "system" declares an overriddenBy port here
        const overriddenSet = new Set(overriddenIds ? overriddenIds.split(",") : []);

        // one config control in the dropdown row. output/reasoning render as
        // ConfigControl selects (shared with the generic branch); "system" is a
        // compact button showing its set-state that opens the system-prompt
        // popover (config.system is long text, edited off-node like cron).
        const renderConfig = (field: ConfigField) => {
            const overridden = overriddenSet.has(field.id);
            if (field.id === "system") {
                const set = (node.config.system ?? "").trim().length > 0;
                return (
                    <label key={field.id} className={"flex min-w-0 flex-1 flex-col gap-0.5"}>
                        <span className={"truncate text-[9px] text-gray-400"}>{field.label}</span>
                        <button
                            type={"button"}
                            disabled={overridden}
                            title={
                                overridden
                                    ? "set by connected edge"
                                    : set
                                      ? "edit the system prompt"
                                      : "set a system prompt"
                            }
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                                const r = e.currentTarget.getBoundingClientRect();
                                onOpenSystem?.({ x: r.left, y: r.bottom + 4 }, node.id);
                            }}
                            className={`w-full min-w-0 border border-foreground/15 bg-background px-1 py-0.5 text-left font-mono text-[10px] ${
                                overridden ? "opacity-40" : "hover:border-foreground/40"
                            }`}
                        >
                            {set ? "set" : "—"}
                        </button>
                    </label>
                );
            }
            return (
                <label key={field.id} className={"flex min-w-0 flex-1 flex-col gap-0.5"}>
                    <span className={"truncate text-[9px] text-gray-400"}>{field.label}</span>
                    <ConfigControl
                        field={field}
                        value={node.config[field.id] ?? ""}
                        disabled={overridden}
                        disabledTitle={overridden ? "set by connected edge" : undefined}
                        dynStr={field.id === "reasoning" ? reasoningOptions : outputOptions}
                        fontClass={"text-[10px]"}
                        onChange={(value) =>
                            dispatch({ type: "setConfig", nodeId: node.id, field: field.id, value })
                        }
                        onFocus={onConfigFocus}
                        onBlur={onConfigBlur}
                    />
                </label>
            );
        };

        return (
            <div
                data-node-id={node.id}
                style={{ left: node.x, top: node.y, width }}
                className={`absolute bg-background font-mono text-xs ${
                    selected ? "outline outline-1 outline-foreground" : ""
                }`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
            >
                <IssueDot level={issueLevel} />
                <NodeFrame accent={styles.edge} />

                <div
                    style={{ height: AGENT_HEADER_H }}
                    className={`flex cursor-grab items-center gap-1 px-2 ${styles.headerBg}`}
                >
                    <EntryIcon entry={entry} />
                    <span className={"truncate"}>{entry.label}</span>
                </div>

                <div
                    style={{
                        height: AGENT_CONFIG_H,
                        paddingLeft: AGENT_LEFT_GUTTER,
                        paddingRight: AGENT_RIGHT_GUTTER,
                    }}
                    className={"flex items-center gap-1.5"}
                >
                    {(entry.config ?? []).map(renderConfig)}
                </div>

                <div className={"flex"} style={{ height: AGENT_LABEL_H + AGENT_PORT_H }}>
                    {bottomPorts.map((spec) => (
                        <div
                            key={spec.id}
                            style={{ width: AGENT_PORT_SLOT }}
                            className={"relative flex justify-center"}
                        >
                            <span
                                style={{ height: AGENT_LABEL_H }}
                                className={
                                    "w-full truncate px-0.5 text-center text-[9px] leading-4 text-gray-400"
                                }
                            >
                                {spec.label}
                            </span>
                            <span
                                className={
                                    "absolute bottom-0 left-1/2 flex -translate-x-1/2 translate-y-1/2"
                                }
                            >
                                {port(spec, "in", "")}
                            </span>
                        </div>
                    ))}
                </div>

                {/* flow "in" on the left edge, centered on the body band */}
                {flowInput && (
                    <span
                        className={"absolute flex"}
                        style={{
                            left: 0,
                            top: AGENT_HEADER_H + AGENT_BODY_H / 2,
                            transform: "translate(-50%, -50%)",
                        }}
                    >
                        {port(flowInput, "in", "")}
                    </span>
                )}

                {/* outputs stacked on the right edge of the body, matching geometry.ts */}
                {entry.outputs.map((spec, i) => {
                    const y = AGENT_HEADER_H + (AGENT_BODY_H * (i + 1)) / (entry.outputs.length + 1);
                    return (
                        <span
                            key={spec.id}
                            className={"absolute flex items-center"}
                            style={{ right: 0, top: y, transform: "translateY(-50%)" }}
                        >
                            {!isGenericLabel(spec.label) && (
                                <span className={"mr-1 text-[9px] leading-none text-gray-400"}>
                                    {spec.label}
                                </span>
                            )}
                            <span className={"flex translate-x-1/2"}>{port(spec, "out", "")}</span>
                        </span>
                    );
                })}
            </div>
        );
    }

    // if nodes render as a compact square (IF_W × IF_H) wearing the agent
    // node's frame: an icon+label header band on top, then a body whose center
    // holds the operator dropdown (glyph + ▾ caret), with the l/in/r inputs on
    // the body's left edge and the true/false flow outputs on its right, each
    // marker absolutely placed on its geometry.ts anchor. No bottom label strip.
    if (isIfEntry(entry)) {
        const operatorField = entry.config?.find((f) => f.id === "operator");
        const operatorOptions = operatorField?.options ?? [];
        return (
            <div
                data-node-id={node.id}
                style={{ left: node.x, top: node.y, width: IF_W }}
                className={`absolute bg-background font-mono text-xs ${
                    selected ? "outline outline-1 outline-foreground" : ""
                }`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
            >
                <IssueDot level={issueLevel} />
                <NodeFrame accent={styles.edge} />

                <div
                    style={{ height: IF_HEADER_H }}
                    className={`flex cursor-grab items-center gap-1 px-2 ${styles.headerBg}`}
                >
                    <EntryIcon entry={entry} />
                    <span className={"truncate"}>{entry.label}</span>
                </div>

                <div style={{ height: IF_BODY_H }} className={"relative cursor-grab"}>
                    {/* centered operator glyph + ▾ caret. The visible unit is
                        pointer-events-none; a transparent <select> overlays
                        just this spot so clicking it opens the dropdown while
                        the rest of the square stays draggable. stopPropagation
                        keeps opening it from starting a node drag. */}
                    <div
                        className={
                            "absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
                        }
                    >
                        <div
                            className={`pointer-events-none flex items-center gap-0.5 whitespace-nowrap text-base font-semibold leading-none ${styles.text}`}
                        >
                            <span>{node.config.operator || "=="}</span>
                            <span className={"text-[8px] text-gray-400"}>{"▾"}</span>
                        </div>
                        <select
                            value={node.config.operator ?? ""}
                            onPointerDown={(e) => e.stopPropagation()}
                            onFocus={onConfigFocus}
                            onBlur={onConfigBlur}
                            onChange={(e) =>
                                dispatch({
                                    type: "setConfig",
                                    nodeId: node.id,
                                    field: "operator",
                                    value: e.target.value,
                                })
                            }
                            className={"absolute inset-0 cursor-pointer opacity-0"}
                        >
                            <option value={""} hidden />
                            {operatorOptions.map((opt) => (
                                <option key={opt} value={opt}>
                                    {opt}
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* l / in / r on the body's left edge, top→bottom in input order */}
                    {entry.inputs.map((spec, i) => {
                        const y = (IF_BODY_H * (i + 1)) / (entry.inputs.length + 1);
                        return (
                            <span key={spec.id}>
                                <span
                                    className={"absolute flex"}
                                    style={{ left: 0, top: y, transform: "translate(-50%, -50%)" }}
                                >
                                    {port(spec, "in", "")}
                                </span>
                                {!isGenericLabel(spec.label) && (
                                    <span
                                        className={"absolute text-[9px] leading-none text-gray-400"}
                                        style={{ left: 8, top: y, transform: "translateY(-50%)" }}
                                    >
                                        {spec.label}
                                    </span>
                                )}
                            </span>
                        );
                    })}

                    {/* true / false flow outputs on the body's right edge */}
                    {entry.outputs.map((spec, j) => {
                        const y = (IF_BODY_H * (j + 1)) / (entry.outputs.length + 1);
                        return (
                            <span key={spec.id}>
                                <span
                                    className={"absolute flex"}
                                    style={{ right: 0, top: y, transform: "translate(50%, -50%)" }}
                                >
                                    {port(spec, "out", "")}
                                </span>
                                <span
                                    className={"absolute text-[9px] leading-none text-gray-400"}
                                    style={{ right: 8, top: y, transform: "translateY(-50%)" }}
                                >
                                    {spec.label}
                                </span>
                            </span>
                        );
                    })}
                </div>
            </div>
        );
    }

    // inputs paired to a config field (overriddenBy) render inline on that
    // row's left edge instead of a port row of their own — see geometry.ts
    const rowInputs = unpairedInputs(entry);
    const rowCount = Math.max(rowInputs.length, entry.outputs.length);
    const rows = Array.from({ length: rowCount }, (_, i) => ({
        input: rowInputs[i],
        output: entry.outputs[i],
    }));

    const overriddenSet = new Set(overriddenIds ? overriddenIds.split(",") : []);

    return (
        <div
            data-node-id={node.id}
            style={{ left: node.x, top: node.y }}
            className={`absolute w-44 bg-background pb-1 font-mono text-xs ${
                selected ? "outline outline-1 outline-foreground" : ""
            } ${entry.missing ? "opacity-50" : ""}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
        >
            <IssueDot level={issueLevel} />
            <NodeFrame
                className={`border-l-2 ${styles.borderL} ${entry.missing ? "border-dashed" : ""}`}
            />
            {/* rectangular extension-event nodes are entry points too — same
                amber cue as the schedule circle */}
            {entry.category === "events" && !entry.missing && <EntryBadge />}
            <div
                style={{ height: HEADER_H }}
                className={`flex cursor-grab items-center gap-1 px-2 ${styles.headerBg}`}
            >
                <EntryIcon entry={entry} />
                <span className={`truncate ${entry.missing ? "text-gray-400" : ""}`}>
                    {entry.label}
                </span>
            </div>

            {rows.map(({ input, output }, i) => (
                <div key={i} className={"flex h-6 items-center justify-between gap-2"}>
                    <span className={"flex min-w-0 items-center gap-1"}>
                        {input && (
                            <>
                                {port(input, "in")}
                                {!isGenericLabel(input.label) && (
                                    <span className={"truncate text-[10px] text-gray-400"}>
                                        {input.label}
                                    </span>
                                )}
                            </>
                        )}
                    </span>
                    <span className={"flex min-w-0 items-center gap-1"}>
                        {output && (
                            <>
                                {!isGenericLabel(output.label) && (
                                    <span className={"truncate text-[10px] text-gray-400"}>
                                        {output.label}
                                    </span>
                                )}
                                {port(output, "out")}
                            </>
                        )}
                    </span>
                </div>
            ))}

            {entry.config?.map((field) => {
                // a connected port takes precedence over the literal — dim
                // and lock the field so it never looks live while ignored
                // (membership computed by the canvas; see overriddenIds)
                const overridden = overriddenSet.has(field.id);
                // the field's input port renders inline on this row's left
                // edge (pl-0 so the -ml-1.5 marker straddles node.x exactly
                // like a port row); geometry.ts anchors the edge at the
                // row's vertical center
                const pairedPort = field.overriddenBy
                    ? entry.inputs.find((p) => p.id === field.overriddenBy)
                    : undefined;
                return (
                <label
                    key={field.id}
                    className={`flex items-center gap-1.5 pr-2 ${
                        pairedPort ? "pl-0" : "pl-2"
                    } ${field.input === "textarea" ? "h-[72px]" : "h-9"}`}
                >
                    {pairedPort && port(pairedPort, "in")}
                    <span className={"w-14 shrink-0 truncate text-[10px] text-gray-400"}>
                        {field.label}
                    </span>
                    <ConfigControl
                        field={field}
                        value={node.config[field.id] ?? ""}
                        disabled={overridden}
                        disabledTitle={overridden ? "set by connected edge" : undefined}
                        dynStr={field.id === "reasoning" ? reasoningOptions : outputOptions}
                        fontClass={"text-xs"}
                        onChange={(value) =>
                            dispatch({ type: "setConfig", nodeId: node.id, field: field.id, value })
                        }
                        onFocus={onConfigFocus}
                        onBlur={onConfigBlur}
                    />
                    {field.picker === "json-path" && onOpenPicker && (
                        <button
                            type={"button"}
                            aria-label={"pick from sample"}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                                const r = e.currentTarget.getBoundingClientRect();
                                onOpenPicker({ x: r.left, y: r.bottom + 4 }, node.id, field.id);
                            }}
                            className={
                                "shrink-0 border border-foreground/15 px-1 py-0.5 text-[10px] text-gray-400 hover:text-foreground"
                            }
                        >
                            {"{}"}
                        </button>
                    )}
                </label>
                );
            })}
        </div>
    );
});
