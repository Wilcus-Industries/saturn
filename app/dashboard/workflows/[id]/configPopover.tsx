"use client";

import { useState } from "react";
import type { CatalogEntry } from "@/lib/workflow";

const PANEL_W = 288; // w-72

// fixed-position popover anchored under an integration ("app") node, hosting
// that provider's config fields as a small form. The backdrop swallows canvas
// events (pan/zoom frozen) and closes on click — mirrors cronPopover.tsx.
// Edits dispatch a transient setConfig per keystroke; the designer collapses
// the whole editing session into one undo step on close (before/commit).
export default function ConfigPopover({
    anchor,
    entry,
    config,
    overriddenIds,
    onChange,
    onClose,
}: {
    anchor: { x: number; y: number };
    entry: CatalogEntry;
    config: Record<string, string>;
    // comma-joined ids of config fields overridden by a connected port — dimmed
    // and locked, like the inline generic config rows (see node.tsx)
    overriddenIds: string;
    onChange: (field: string, value: string) => void;
    onClose: () => void;
}) {
    // clamp once at mount — the backdrop prevents the anchor from going stale
    const [position] = useState(() => ({
        left: Math.max(8, Math.min(anchor.x, window.innerWidth - PANEL_W - 8)),
        top: Math.max(8, Math.min(anchor.y, window.innerHeight - 220)),
    }));
    const overridden = new Set(overriddenIds ? overriddenIds.split(",") : []);

    return (
        <>
            <div className={"fixed inset-0 z-40"} onPointerDown={onClose} />
            <div
                style={position}
                className={
                    "fixed z-50 flex w-72 flex-col gap-2 border border-foreground/15 bg-background p-3 font-mono text-xs shadow-lg"
                }
            >
                <div className={"truncate text-[10px] uppercase tracking-wide text-gray-400"}>
                    {entry.label}
                </div>
                {entry.config?.map((field) => {
                    const isOverridden = overridden.has(field.id);
                    const shared = {
                        value: config[field.id] ?? "",
                        disabled: isOverridden,
                        title: isOverridden ? "set by connected edge" : undefined,
                        onChange: (e: { target: { value: string } }) =>
                            onChange(field.id, e.target.value),
                        className: `w-full min-w-0 border border-foreground/15 bg-background px-1 py-0.5 font-mono text-xs ${
                            isOverridden ? "opacity-40" : ""
                        }`,
                    };
                    return (
                        <label key={field.id} className={"flex flex-col gap-1"}>
                            <span className={"text-[10px] text-gray-400"}>{field.label}</span>
                            {field.input === "select" ? (
                                <select {...shared}>
                                    <option value={""} hidden />
                                    {(field.options ?? []).map((opt) => (
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
                                    className={`${shared.className} h-[60px] resize-none`}
                                />
                            ) : (
                                <input
                                    {...shared}
                                    type={field.input}
                                    placeholder={field.placeholder}
                                />
                            )}
                        </label>
                    );
                })}
            </div>
        </>
    );
}
