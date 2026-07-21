"use client";

import { useState } from "react";
import PopoverShell from "./popoverShell";

// fixed-position popover anchored under an agent node's "system" button, hosting
// a textarea that edits config.system. Uses the shared PopoverShell (measure-
// and-clamp positioning + backdrop that freezes canvas events and closes on
// click). The textarea seeds from `initial` (a snapshot taken when the popover
// opened) and drives its own state, calling onChange on every keystroke — the
// designer dispatches each change onto the graph and coalesces the whole
// editing session into ONE undo step on close (before/commitConfig, exactly
// like the cron popover). The system port still overrides config.system when
// wired, so the button that opens this is disabled while that port is connected.
export default function SystemPopover({
    anchor,
    initial,
    onChange,
    onClose,
}: {
    anchor: { x: number; y: number };
    initial: string;
    onChange: (value: string) => void;
    onClose: () => void;
}) {
    const [value, setValue] = useState(initial);
    return (
        <PopoverShell
            anchor={anchor}
            onClose={onClose}
            className={"flex w-80 flex-col gap-1.5 border border-foreground/15 bg-background p-3 shadow-lg"}
        >
            <span className={"font-mono text-[11px] text-gray-400"}>system prompt</span>
            <textarea
                autoFocus
                value={value}
                rows={8}
                maxLength={4000}
                placeholder={"instructions that shape the agent's behavior"}
                onChange={(e) => {
                    setValue(e.target.value);
                    onChange(e.target.value);
                }}
                className={
                    "w-full resize-none border border-foreground/15 bg-background px-2 py-1.5 font-mono text-xs outline-none placeholder:text-gray-500"
                }
            />
        </PopoverShell>
    );
}
