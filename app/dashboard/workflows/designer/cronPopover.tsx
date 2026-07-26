"use client";

import CronBuilder from "@/app/dashboard/(shell)/workflows/cronBuilder";
import PopoverShell from "./popoverShell";

// fixed-position popover anchored under a schedule node, hosting the cron
// builder in callback mode. Uses the shared PopoverShell (measure-and-clamp
// positioning + backdrop that freezes canvas events and closes on click).
// No floorMinutes: plans are gone, so the builder's own 1-minute floor (the
// scheduler's tick) is the only limit.
export default function CronPopover({
    anchor,
    initial,
    onChange,
    onClose,
}: {
    anchor: { x: number; y: number };
    initial: string;
    onChange: (cron: string) => void;
    onClose: () => void;
}) {
    return (
        <PopoverShell
            anchor={anchor}
            onClose={onClose}
            className={"w-72 border border-foreground/15 bg-background p-3 shadow-lg"}
        >
            <CronBuilder initial={initial} onChange={onChange} />
        </PopoverShell>
    );
}
