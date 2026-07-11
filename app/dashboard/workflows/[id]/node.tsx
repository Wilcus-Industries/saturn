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
    type PortKind,
    type PortSpec,
    type WorkflowGraph,
    type WorkflowNode,
} from "@/lib/workflow";
import EntryIcon from "./entryIcon";
import { GRID } from "./geometry";
import type { GraphAction } from "./graphReducer";

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

// renders to the geometry.ts metrics exactly: w-44 = NODE_W 176, h-8 header
// = HEADER_H 32, h-6 port rows = PORT_ROW_H 24, h-9 config rows =
// CONFIG_ROW_H 36 (h-[72px] textarea rows = TEXTAREA_ROW_H 72), pb-1 = 4px
// bottom pad. Change sizes only via geometry.ts.

// selection count for a grant-picker field's JSON string array value
function grantCount(raw: string): number {
    if (!raw) return 0;
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
        return 0;
    }
}

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
    graphRef,
    selected,
    selectionRef,
    setSelection,
    dispatch,
    zoom,
    overriddenIds,
    pendingKind,
    onPortPointerDown,
    onOpenPicker,
}: {
    node: WorkflowNode;
    entry: CatalogEntry;
    graphRef: RefObject<WorkflowGraph>;
    selected: boolean;
    selectionRef: RefObject<Set<string>>;
    setSelection: Dispatch<SetStateAction<Set<string>>>;
    dispatch: Dispatch<GraphAction>;
    zoom: number;
    // comma-joined config field ids currently overridden by a connected
    // port (computed by the canvas so this memo prop is a comparable string)
    overriddenIds: string;
    // kind of the in-flight edge drag (null when none, or when it started on
    // this node) — matching ports scale up as a drop affordance
    pendingKind: PortKind | null;
    onPortPointerDown: PortPointerDownHandler;
    onOpenPicker?: OpenPickerHandler;
}) {
    const styles = CATEGORY_STYLES[entry.category];
    const dragRef = useRef<DragState | null>(null);
    const configBeforeRef = useRef<WorkflowGraph | null>(null);

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
        // settle each dragged node onto the grid, then record one undo step
        for (const id of drag.ids) {
            const n = graphRef.current.nodes.find((candidate) => candidate.id === id);
            if (!n) continue;
            const dx = Math.round(n.x / GRID) * GRID - n.x;
            const dy = Math.round(n.y / GRID) * GRID - n.y;
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
    const port = (spec: PortSpec, dir: "in" | "out") => (
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
            className={`shrink-0 cursor-crosshair text-[10px] leading-none transition-transform ${
                dir === "in" ? "-ml-1.5" : "-mr-1.5"
            } ${spec.kind === "flow" ? "text-foreground" : styles.text} ${
                pendingKind === spec.kind ? "scale-125" : ""
            }`}
        >
            {spec.kind === "flow" ? "▶" : "○"}
        </button>
    );

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
                                <span className={"truncate text-[10px] text-gray-400"}>
                                    {input.label}
                                </span>
                            </>
                        )}
                    </span>
                    <span className={"flex min-w-0 items-center gap-1"}>
                        {output && (
                            <>
                                <span className={"truncate text-[10px] text-gray-400"}>
                                    {output.label}
                                </span>
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
                const grant = field.picker === "tools" || field.picker === "skills";
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
                    {grant ? (
                        // the JSON array value isn't hand-editable — the row
                        // is a button opening the grant picker
                        <button
                            type={"button"}
                            disabled={!onOpenPicker}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                                const r = e.currentTarget.getBoundingClientRect();
                                onOpenPicker?.({ x: r.left, y: r.bottom + 4 }, node.id, field.id);
                            }}
                            className={`${shared.className} text-left text-gray-400 hover:text-foreground`}
                        >
                            {grantCount(node.config[field.id] ?? "") || "none"}
                            {" selected"}
                        </button>
                    ) : field.input === "select" ? (
                        <select {...shared} onChange={onChange}>
                            <option value={""} hidden />
                            {field.options?.map((opt) => (
                                <option key={opt} value={opt}>
                                    {opt}
                                </option>
                            ))}
                        </select>
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
