"use client";

import CronBuilder from "@/app/dashboard/(shell)/workflows/cronBuilder";
import PopoverShell from "./popoverShell";

// fixed-position popover anchored under a schedule node, hosting the cron
// builder in callback mode. Uses the shared PopoverShell (measure-and-clamp
// positioning + backdrop that freezes canvas events and closes on click).
// floorMinutes caps the builder's interval choices to the user's tier cron floor.
export default function CronPopover({
    anchor,
    initial,
    floorMinutes,
    onChange,
    onClose,
}: {
    anchor: { x: number; y: number };
    initial: string;
    floorMinutes: number;
    onChange: (cron: string) => void;
    onClose: () => void;
}) {
    return (
        <PopoverShell
            anchor={anchor}
            onClose={onClose}
            className={"w-72 border border-foreground/15 bg-background p-3 shadow-lg"}
        >
            <CronBuilder initial={initial} floorMinutes={floorMinutes} onChange={onChange} />
        </PopoverShell>
    );
}
