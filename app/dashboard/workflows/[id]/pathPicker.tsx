"use client";

import { useState } from "react";

// what the designer resolved for the extract node's upstream sample when the
// picker was opened; contents stay frozen while the popover is up
export type PickerSample =
    | { kind: "no-edge" } // extract's value input not connected
    | { kind: "no-sample" } // connected, but no test run yet
    | { kind: "raw"; text: string } // sample isn't JSON
    | { kind: "too-large" } // above the parse cap
    | { kind: "json"; value: unknown };

const PANEL_W = 320; // w-80
const PANEL_MAX_H = 320; // max-h-80
const MAX_CHILDREN = 100; // rendered per level; rest collapse into "+N more"
const PREVIEW_CHARS = 40;

const preview = (v: unknown): string => {
    const s = JSON.stringify(v) ?? "undefined";
    return s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS)}…` : s;
};

const isContainer = (v: unknown): v is object =>
    typeof v === "object" && v !== null;

// the extract evaluator splits on "." — a key containing a dot (or an empty
// key) can never be addressed, so its whole subtree is unpickable
const addressable = (key: string) => key !== "" && !key.includes(".");

// fixed-position popover anchored under the extract node's pick button; the
// backdrop swallows canvas events (pan/zoom frozen) and closes on click
export default function PathPicker({
    anchor,
    sample,
    onPick,
    onClose,
}: {
    anchor: { x: number; y: number };
    sample: PickerSample;
    onPick: (path: string) => void;
    onClose: () => void;
}) {
    // clamp once at mount — the backdrop prevents the anchor from going stale
    const [position] = useState(() => ({
        left: Math.max(8, Math.min(anchor.x, window.innerWidth - PANEL_W - 8)),
        top: Math.max(8, Math.min(anchor.y, window.innerHeight - PANEL_MAX_H - 8)),
    }));
    // expanded container paths; root ("") starts open
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));

    const toggle = (path: string) =>
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });

    // one row per value: containers toggle, leaves pick their dot-path
    const renderTree = (value: unknown, path: string, key: string, reachable: boolean) => {
        if (isContainer(value)) {
            const entries = Array.isArray(value)
                ? value.map((v, i): [string, unknown] => [String(i), v])
                : Object.entries(value as Record<string, unknown>);
            const open = expanded.has(path);
            const count = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`;
            return (
                <div key={path}>
                    <button
                        type={"button"}
                        onClick={() => toggle(path)}
                        className={`flex w-full items-center gap-1 px-1 py-0.5 text-left ${
                            reachable ? "hover:bg-foreground/5" : "text-gray-500"
                        }`}
                        title={reachable ? undefined : "key contains '.' — not addressable"}
                    >
                        <span className={"text-gray-400"}>{open ? "▾" : "▸"}</span>
                        <span className={"truncate"}>{key || "(root)"}</span>
                        <span className={"shrink-0 text-gray-400"}>{count}</span>
                    </button>
                    {open && (
                        <div className={"border-l border-foreground/10 pl-3"}>
                            {entries.slice(0, MAX_CHILDREN).map(([k, v]) => {
                                const childReachable =
                                    reachable && (Array.isArray(value) || addressable(k));
                                const childPath = path ? `${path}.${k}` : k;
                                return renderTree(v, childPath, k, childReachable);
                            })}
                            {entries.length > MAX_CHILDREN && (
                                <p className={"px-1 py-0.5 text-gray-500"}>
                                    +{entries.length - MAX_CHILDREN} more
                                </p>
                            )}
                        </div>
                    )}
                </div>
            );
        }
        return (
            <button
                key={path}
                type={"button"}
                disabled={!reachable}
                onClick={() => onPick(path)}
                className={`flex w-full items-baseline gap-1.5 px-1 py-0.5 text-left ${
                    reachable
                        ? "hover:bg-foreground/10"
                        : "cursor-not-allowed text-gray-500"
                }`}
                title={reachable ? undefined : "key contains '.' — not addressable"}
            >
                <span className={"truncate"}>{path ? key : "(whole value)"}</span>
                <span className={"truncate text-gray-400"}>{preview(value)}</span>
            </button>
        );
    };

    return (
        <>
            <div className={"fixed inset-0 z-40"} onPointerDown={onClose} />
            <div
                style={position}
                className={
                    "fixed z-50 max-h-80 w-80 overflow-auto border border-foreground/15 bg-background p-1 font-mono text-xs shadow-lg"
                }
            >
                {sample.kind === "no-edge" && (
                    <p className={"p-2 text-gray-400"}>connect the value input first</p>
                )}
                {sample.kind === "no-sample" && (
                    <p className={"p-2 text-gray-400"}>
                        run the workflow once to sample the upstream output
                    </p>
                )}
                {sample.kind === "too-large" && (
                    <p className={"p-2 text-gray-400"}>sample too large to browse</p>
                )}
                {sample.kind === "raw" && (
                    <div className={"p-2"}>
                        <p className={"text-gray-400"}>upstream output is not JSON:</p>
                        <p className={"mt-1 break-words text-gray-500"}>
                            {sample.text.slice(0, 500)}
                        </p>
                    </div>
                )}
                {sample.kind === "json" && renderTree(sample.value, "", "", true)}
            </div>
        </>
    );
}
