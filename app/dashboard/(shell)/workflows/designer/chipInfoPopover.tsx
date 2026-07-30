"use client";

import type { CatalogEntry } from "@/lib/workflow";
import PopoverShell from "./popoverShell";

// fixed-position read-only info popover anchored under a skill or memory grant
// chip: emoji + name + description + a one-line wiring hint. Uses the shared
// PopoverShell (measure-and-clamp positioning + backdrop that freezes canvas
// events and closes on click). Skill/memory chips carry no config, so this is
// purely informational — the counterpart to the mcp chip's tool picker, which
// makes every chip clickable rather than a dead-click next to it.
export default function ChipInfoPopover({
    anchor,
    entry,
    onClose,
}: {
    anchor: { x: number; y: number };
    entry: CatalogEntry; // the chip's catalog entry — label/emoji/description
    onClose: () => void;
}) {
    const isMemory = entry.category === "memory";
    return (
        <PopoverShell
            anchor={anchor}
            onClose={onClose}
            className={
                "flex w-64 flex-col gap-2 border border-foreground/15 bg-background p-3 font-mono text-xs shadow-lg"
            }
        >
            <div className={"flex items-center gap-2"}>
                {entry.emoji && <span className={"text-lg leading-none"}>{entry.emoji}</span>}
                <span className={"truncate font-semibold"}>{entry.label}</span>
            </div>
            {entry.description ? (
                <p className={"whitespace-pre-wrap text-[11px] text-gray-400"}>{entry.description}</p>
            ) : (
                <p className={"text-[11px] text-gray-500"}>no description</p>
            )}
            <p className={"text-[10px] text-gray-500"}>
                {isMemory
                    ? "wire the output into an agent's memory port"
                    : "wire the output into an agent's skills port"}
            </p>
        </PopoverShell>
    );
}
