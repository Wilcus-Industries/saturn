"use client";

import {
    type Dispatch,
    memo,
    type PointerEvent as ReactPointerEvent,
    type RefObject,
    type SetStateAction,
    useRef,
} from "react";
import {
    CATEGORY_STYLES,
    type CatalogEntry,
    type ConfigField,
    type PortKind,
    type PortSpec,
    type WorkflowGraph,
    type WorkflowNode,
} from "@/lib/workflow";
import { describeCron } from "@/lib/cron";
import McpLogo from "@/app/dashboard/mcpLogo";
import EntryIcon from "./entryIcon";
import {
    AGENT_CONFIG_H,
    AGENT_HEADER_H,
    AGENT_LABEL_H,
    AGENT_LEFT_GUTTER,
    AGENT_PORT_H,
    AGENT_PORT_SLOT,
    AGENT_RIGHT_GUTTER,
    AGENT_TOP_H,
    anchorOffsetY,
    GRID,
    EVENT_H,
    EVENT_W,
    HEADER_H,
    IF_H,
    IF_W,
    isAgentEntry,
    isEventEntry,
    isIfEntry,
    isLiteralEntry,
    isMcpChipEntry,
    isModelEntry,
    isSkillChipEntry,
    MCP_CHIP,
    MODEL_D,
    nodeHeight,
    nodeWidth,
    SKILL_CHIP,
} from "./geometry";
import type { GraphAction } from "./graphReducer";
import ModelLogo from "./modelLogo";

// generic single-io labels ("in"/"out") add no signal over the port marker
// (▶/○) and its side, so they're hidden — named ports (a/b/prompt/true…) stay
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

// renders to the geometry.ts metrics exactly: w-44 = NODE_W 176, h-8 header
// = HEADER_H 32, h-6 port rows = PORT_ROW_H 24, h-9 config rows =
// CONFIG_ROW_H 36 (h-[72px] textarea rows = TEXTAREA_ROW_H 72), pb-1 = 4px
// bottom pad. Model nodes render circular: h-18 w-18 = MODEL_D 72 plus an
// h-6 name strip = MODEL_LABEL_H 24. Event nodes render circular too:
// h-12 w-12 = EVENT_H 48 × EVENT_W 48 plus an h-6 label strip = EVENT_LABEL_H
// 24. Change sizes only via geometry.ts.

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
    pendingKind,
    onPortPointerDown,
    onOpenPicker,
    onOpenCron,
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
    // kind of the in-flight edge drag (null when none, or when it started on
    // this node) — matching ports scale up as a drop affordance
    pendingKind: PortKind | null;
    onPortPointerDown: PortPointerDownHandler;
    onOpenPicker?: OpenPickerHandler;
    onOpenCron?: OpenCronHandler;
}) {
    const styles = CATEGORY_STYLES[entry.category];
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
    // must get the same instance addEventListener got.
    const dragEscapeRef = useRef<((e: KeyboardEvent) => void) | null>(null);
    const removeDragEscape = () => {
        if (!dragEscapeRef.current) return;
        window.removeEventListener("keydown", dragEscapeRef.current);
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
        const onEscape = (ev: KeyboardEvent) => {
            if (ev.key !== "Escape") return;
            const drag = dragRef.current;
            dragRef.current = null;
            removeDragEscape();
            if (drag?.active) dispatch({ type: "cancelDrag", before: drag.before });
        };
        dragEscapeRef.current = onEscape;
        window.addEventListener("keydown", onEscape);
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
    ) => (
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
            className={`shrink-0 cursor-crosshair text-[10px] leading-none transition-transform ${marginClass} ${
                spec.kind === "flow" ? "text-foreground" : styles.text
            } ${
                pendingKind === spec.kind ? "scale-125" : ""
            }`}
        >
            {spec.kind === "flow" ? "▶" : "○"}
        </button>
    );

    // model nodes render as a circle (h-18 w-18 = MODEL_D 72, h-6 name strip
    // = MODEL_LABEL_H 24) — the single value output anchors on the circle's
    // right-edge midpoint per geometry.ts. Nodes spawned from a per-model
    // toolbox chip carry config.preset = "1" and show a read-only name;
    // without it (blank chip, legacy graphs) the slug stays editable.
    if (isModelEntry(entry)) {
        const output = entry.outputs[0];
        const readOnly = node.config.preset === "1";
        const name = node.config.model || entry.label;
        // the author prefix ("openai/…") eats the narrow strip — show only
        // the model segment; the full slug stays in the title tooltip
        const shortName = name.slice(name.indexOf("/") + 1);
        return (
            <div
                data-node-id={node.id}
                style={{ left: node.x, top: node.y, width: MODEL_D }}
                className={"absolute font-mono text-xs"}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
            >
                <div
                    style={{ width: MODEL_D, height: MODEL_D }}
                    className={`relative flex cursor-grab items-center justify-center rounded-full border border-foreground/25 bg-background ${styles.headerBg} ${
                        selected ? "outline outline-1 outline-foreground" : ""
                    }`}
                >
                    {/* logo fills the circle; clip here (not on the circle
                        div) so the edge-straddling port isn't cut off */}
                    <span
                        style={{ width: MODEL_D, height: MODEL_D }}
                        className={"flex overflow-hidden rounded-full"}
                    >
                        <ModelLogo slug={node.config.model ?? ""} name={name} size={MODEL_D} />
                    </span>
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
                </div>
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

    // event nodes render as a circle (h-12 w-12 = EVENT_H × EVENT_W, h-6 label
    // strip = EVENT_LABEL_H) with the icon centered and the label underneath —
    // the single flow output anchors on the circle's right-edge midpoint per
    // geometry.ts, mirroring the model branch above.
    if (isEventEntry(entry)) {
        const output = entry.outputs[0];
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

        // a press that stayed under the drag threshold is a click → open the
        // cron popover (mirrors the literal box's click-to-focus)
        const eventEndDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
            const wasClick = !!dragRef.current && !dragRef.current.active;
            endDrag();
            if (wasClick && hasCron && onOpenCron) {
                const r = e.currentTarget.getBoundingClientRect();
                onOpenCron({ x: r.left, y: r.bottom + 4 }, node.id);
            }
        };

        return (
            <div
                data-node-id={node.id}
                style={{ left: node.x, top: node.y, width: EVENT_W }}
                className={"absolute font-mono text-xs"}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={hasCron ? eventEndDrag : endDrag}
                onPointerCancel={endDrag}
            >
                <div
                    // border tinted to the category color (same hex the edges use)
                    style={{ borderColor: styles.edge, width: EVENT_W, height: EVENT_H }}
                    className={`relative flex ${hasCron ? "cursor-pointer" : "cursor-grab"} items-center justify-center rounded-full border bg-background ${styles.headerBg} ${
                        selected ? "outline outline-1 outline-foreground" : ""
                    }`}
                >
                    {entry.emoji ? (
                        <span className={"text-2xl leading-none"}>{entry.emoji}</span>
                    ) : (
                        // ▶ glyph's mass leans left; nudge right to optically center
                        <span className={`translate-x-[2px] text-2xl leading-none ${styles.text}`}>
                            {"▶"}
                        </span>
                    )}
                    {output &&
                        (() => {
                            const [ax, ay] = parsedOutAnchor ?? [EVENT_W, EVENT_H / 2];
                            // point the ▶ along the outward normal it rotated to
                            const deg =
                                (Math.atan2(ay - EVENT_H / 2, ax - EVENT_W / 2) * 180) / Math.PI;
                            return (
                                <span
                                    className={"absolute flex"}
                                    style={{
                                        left: ax,
                                        top: ay,
                                        transform: `translate(-50%, -50%) rotate(${deg}deg)`,
                                    }}
                                >
                                    {port(output, "out", "")}
                                </span>
                            );
                        })()}
                </div>
                <div
                    style={{ width: EVENT_W }}
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

    // mcp/skill grant chips render as a rounded square (60px mcp / 48px skill
    // = MCP_CHIP/SKILL_CHIP, h-6 label strip = CHIP_LABEL_H) with the server
    // favicon / skill emoji centered and a single value output on the
    // right-edge midpoint per geometry.ts, mirroring the model circle branch.
    // Border is the category color as a LITERAL Tailwind class (JIT can't see
    // computed names) — purple mcp / green skill, matching CATEGORY_STYLES.
    if (isMcpChipEntry(entry) || isSkillChipEntry(entry)) {
        const output = entry.outputs[0];
        const mcp = isMcpChipEntry(entry);
        const size = mcp ? MCP_CHIP : SKILL_CHIP;
        const border = mcp ? "border-purple-500" : "border-green-500";
        return (
            <div
                data-node-id={node.id}
                style={{ left: node.x, top: node.y, width: size }}
                className={"absolute font-mono text-xs"}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
            >
                <div
                    style={{ width: size, height: size }}
                    className={`relative flex cursor-grab items-center justify-center rounded-xl border-2 bg-background ${border} ${styles.headerBg} ${
                        selected ? "outline outline-1 outline-foreground" : ""
                    }`}
                >
                    {mcp ? (
                        <McpLogo domain={entry.logoDomain ?? ""} name={entry.label} size={"fill"} />
                    ) : (
                        <span className={"text-2xl leading-none"}>{entry.emoji}</span>
                    )}
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
                </div>
                <div className={"flex h-6 items-center justify-center"}>
                    <span
                        className={
                            "line-clamp-2 max-w-full break-words text-center text-[10px] leading-3"
                        }
                        title={mcp ? `${entry.group} · ${entry.label}` : entry.label}
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
                className={"absolute font-mono text-xs"}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={literalEndDrag}
                onPointerCancel={endDrag}
            >
                <div
                    style={{ height }}
                    className={`relative flex cursor-grab items-stretch rounded border border-foreground/25 bg-background px-2 py-1.5 ${
                        selected ? "outline outline-1 outline-foreground" : ""
                    }`}
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

        // one output/reasoning dropdown — mirrors the generic select branch's
        // dynamicOptions handling, gated on the resolved model
        const renderSelect = (field: ConfigField) => {
            const dynStr = field.id === "reasoning" ? reasoningOptions : outputOptions;
            const options = field.dynamicOptions
                ? dynStr
                    ? dynStr.split(",")
                    : []
                : (field.options ?? []);
            const locked = field.dynamicOptions && options.length === 0;
            return (
                <label key={field.id} className={"flex min-w-0 flex-1 flex-col gap-0.5"}>
                    <span className={"truncate text-[9px] text-gray-400"}>{field.label}</span>
                    <select
                        value={node.config[field.id] ?? ""}
                        disabled={locked}
                        title={
                            locked
                                ? field.id === "reasoning"
                                    ? "model has no reasoning setting — pick a reasoning-capable model"
                                    : "output modalities unknown — set a model from the OpenRouter list"
                                : undefined
                        }
                        onPointerDown={(e) => e.stopPropagation()}
                        onFocus={onConfigFocus}
                        onBlur={onConfigBlur}
                        onChange={(e) =>
                            dispatch({
                                type: "setConfig",
                                nodeId: node.id,
                                field: field.id,
                                value: e.target.value,
                            })
                        }
                        className={`w-full min-w-0 border border-foreground/15 bg-background px-1 py-0.5 font-mono text-[10px] ${
                            locked ? "opacity-40" : ""
                        }`}
                    >
                        <option value={""} hidden />
                        {options.map((opt) => (
                            <option key={opt} value={opt}>
                                {opt}
                            </option>
                        ))}
                    </select>
                </label>
            );
        };

        return (
            <div
                data-node-id={node.id}
                style={{ left: node.x, top: node.y, width, borderTopColor: styles.edge }}
                className={`absolute border border-foreground/25 border-t-2 bg-background font-mono text-xs ${
                    selected ? "outline outline-1 outline-foreground" : ""
                }`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
            >
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
                    {(entry.config ?? []).map(renderSelect)}
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

                {/* flow "in" on the left edge, centered on the top band */}
                {flowInput && (
                    <span
                        className={"absolute flex"}
                        style={{ left: 0, top: AGENT_TOP_H / 2, transform: "translate(-50%, -50%)" }}
                    >
                        {port(flowInput, "in", "")}
                    </span>
                )}

                {/* outputs stacked on the right edge, matching geometry.ts */}
                {entry.outputs.map((spec, i) => {
                    const y = (AGENT_TOP_H * (i + 1)) / (entry.outputs.length + 1);
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

    // if nodes render as a headerless rounded square (IF_W × IF_H): the
    // operator dropdown sits dead center (glyph + ▾ caret), the l/in/r inputs
    // stack on the left edge and the true/false flow outputs on the right,
    // each marker absolutely placed on its geometry.ts anchor. No header, no
    // bottom label strip.
    if (isIfEntry(entry)) {
        const operatorField = entry.config?.find((f) => f.id === "operator");
        const operatorOptions = operatorField?.options ?? [];
        return (
            <div
                data-node-id={node.id}
                style={{ left: node.x, top: node.y, width: IF_W }}
                className={"absolute font-mono text-xs"}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
            >
                <div
                    style={{ height: IF_H, borderColor: styles.edge }}
                    className={`relative cursor-grab rounded-2xl border bg-background ${styles.headerBg} ${
                        selected ? "outline outline-1 outline-foreground" : ""
                    }`}
                >
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

                    {/* l / in / r on the left edge, top→bottom in input order */}
                    {entry.inputs.map((spec, i) => {
                        const y = (IF_H * (i + 1)) / (entry.inputs.length + 1);
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

                    {/* true / false flow outputs on the right edge */}
                    {entry.outputs.map((spec, j) => {
                        const y = (IF_H * (j + 1)) / (entry.outputs.length + 1);
                        return (
                            <span key={spec.id}>
                                <span
                                    className={"absolute flex"}
                                    style={{ left: IF_W, top: y, transform: "translate(-50%, -50%)" }}
                                >
                                    {port(spec, "out", "")}
                                </span>
                                <span
                                    className={"absolute text-[9px] leading-none text-gray-400"}
                                    style={{
                                        left: IF_W - 8,
                                        top: y,
                                        transform: "translate(-100%, -50%)",
                                    }}
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

    const rowCount = Math.max(entry.inputs.length, entry.outputs.length);
    const rows = Array.from({ length: rowCount }, (_, i) => ({
        input: entry.inputs[i],
        output: entry.outputs[i],
    }));

    const overriddenSet = new Set(overriddenIds ? overriddenIds.split(",") : []);

    return (
        <div
            data-node-id={node.id}
            style={{ left: node.x, top: node.y }}
            className={`absolute w-44 border border-foreground/25 border-l-2 bg-background pb-1 font-mono text-xs ${styles.borderL} ${
                selected ? "outline outline-1 outline-foreground" : ""
            } ${entry.missing ? "border-dashed opacity-50" : ""}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
        >
            <div className={`flex h-8 cursor-grab items-center gap-1 px-2 ${styles.headerBg}`}>
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
                const shared = {
                    value: node.config[field.id] ?? "",
                    disabled: overridden,
                    title: overridden ? "set by connected edge" : undefined,
                    onPointerDown: (e: ReactPointerEvent) => e.stopPropagation(),
                    onFocus: onConfigFocus,
                    onBlur: onConfigBlur,
                    className: `w-full min-w-0 border border-foreground/15 bg-background px-1 py-0.5 font-mono text-xs ${
                        overridden ? "opacity-40" : ""
                    }`,
                };
                const onChange = (e: { target: { value: string } }) =>
                    dispatch({
                        type: "setConfig",
                        nodeId: node.id,
                        field: field.id,
                        value: e.target.value,
                    });
                return (
                <label
                    key={field.id}
                    className={`flex items-center gap-1.5 px-2 ${
                        field.input === "textarea" ? "h-[72px]" : "h-9"
                    }`}
                >
                    <span className={"w-14 shrink-0 truncate text-[10px] text-gray-400"}>
                        {field.label}
                    </span>
                    {field.input === "select" ? (
                        (() => {
                            const dynStr =
                                field.id === "reasoning" ? reasoningOptions : outputOptions;
                            const options = field.dynamicOptions
                                ? dynStr
                                    ? dynStr.split(",")
                                    : []
                                : (field.options ?? []);
                            const locked = field.dynamicOptions && options.length === 0;
                            return (
                                <select
                                    {...shared}
                                    disabled={shared.disabled || locked}
                                    title={
                                        locked
                                            ? field.id === "reasoning"
                                                ? "model has no reasoning setting — pick a reasoning-capable model"
                                                : "output modalities unknown — set a model from the OpenRouter list"
                                            : shared.title
                                    }
                                    onChange={onChange}
                                >
                                    <option value={""} hidden />
                                    {options.map((opt) => (
                                        <option key={opt} value={opt}>
                                            {opt}
                                        </option>
                                    ))}
                                </select>
                            );
                        })()
                    ) : field.input === "textarea" ? (
                        <textarea
                            {...shared}
                            rows={3}
                            maxLength={4000}
                            placeholder={field.placeholder}
                            onChange={onChange}
                            className={`${shared.className} h-[60px] resize-none`}
                        />
                    ) : (
                        <input
                            {...shared}
                            type={field.input}
                            placeholder={field.placeholder}
                            onChange={onChange}
                        />
                    )}
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
