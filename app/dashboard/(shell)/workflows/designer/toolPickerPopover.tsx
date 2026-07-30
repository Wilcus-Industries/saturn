"use client";

import { MAX_GRANTED_TOOLS, parseToolExclusions } from "@/lib/agent";
import type { CatalogEntry } from "@/lib/workflow";
import PopoverShell from "./popoverShell";

// fixed-position popover anchored under an mcp server chip: cherry-pick which
// of the server's tools this node grants. Uses the shared PopoverShell
// (measure-and-clamp positioning + backdrop that swallows canvas events and
// closes on click). Checked = granted; unchecking a tool adds its name to the
// node's config.exclude (a JSON array string) — an exclude-list, so tools
// discovered later are granted automatically unless pruned. Edits dispatch a
// transient setConfig per toggle; the designer collapses the session into one
// undo step on close (before/commit).
export default function ToolPickerPopover({
    anchor,
    entry,
    exclude,
    onChange,
    onClose,
}: {
    anchor: { x: number; y: number };
    entry: CatalogEntry; // the server node's catalog entry — label + tools
    exclude: string; // current config.exclude raw value
    onChange: (nextExclude: string) => void;
    onClose: () => void;
}) {
    const tools = entry.tools ?? [];
    // malformed stored value → treat as none excluded, matching the runtime's
    // fail-open grant-all; stale names (no longer on the server) drop from the
    // set here, so the next toggle self-prunes them from the stored value
    const parsed = parseToolExclusions(exclude) ?? [];
    const excluded = new Set(parsed.filter((name) => tools.some((t) => t.name === name)));
    const granted = tools.length - excluded.size;

    const toggle = (name: string) => {
        const next = new Set(excluded);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        onChange(next.size ? JSON.stringify([...next]) : "");
    };

    return (
        <PopoverShell
            anchor={anchor}
            onClose={onClose}
            className={
                "flex w-72 flex-col gap-2 border border-foreground/15 bg-background p-3 font-mono text-xs shadow-lg"
            }
        >
            <div className={"truncate text-[10px] uppercase tracking-wide text-gray-400"}>
                {entry.label}
            </div>
                {tools.length === 0 ? (
                    <p className={"text-[10px] text-gray-400"}>
                        no enabled tools — enable them in settings
                    </p>
                ) : (
                    <>
                        <p className={"text-[10px] text-gray-400"}>
                            all tools granted by default — new tools are included
                            automatically
                        </p>
                        <div className={"flex max-h-64 flex-col gap-1 overflow-y-auto"}>
                            {tools.map((tool) => (
                                <label
                                    key={tool.name}
                                    title={tool.description}
                                    className={
                                        "flex cursor-pointer items-center gap-2 py-0.5 hover:bg-foreground/5"
                                    }
                                >
                                    <input
                                        type={"checkbox"}
                                        checked={!excluded.has(tool.name)}
                                        onChange={() => toggle(tool.name)}
                                        className={"shrink-0 accent-purple-500"}
                                    />
                                    <span className={"truncate"}>{tool.name}</span>
                                </label>
                            ))}
                        </div>
                        <p className={"text-[10px] text-gray-400"}>
                            {granted} of {tools.length} granted
                            {tools.length > MAX_GRANTED_TOOLS &&
                                ` — runs cap at ${MAX_GRANTED_TOOLS} tools`}
                        </p>
                    </>
                )}
        </PopoverShell>
    );
}
