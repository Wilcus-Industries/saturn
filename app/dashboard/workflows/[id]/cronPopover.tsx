"use client";

import { useState } from "react";
import CronBuilder from "@/app/dashboard/(shell)/workflows/cronBuilder";

const PANEL_W = 288; // w-72

// fixed-position popover anchored under a schedule node, hosting the cron
// builder in callback mode. The backdrop swallows canvas events (pan/zoom
// frozen) and closes on click — mirrors pathPicker.tsx. floorMinutes caps the
// builder's interval choices to the user's tier cron floor.
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
    // clamp once at mount — the backdrop prevents the anchor from going stale
    const [position] = useState(() => ({
        left: Math.max(8, Math.min(anchor.x, window.innerWidth - PANEL_W - 8)),
        top: Math.max(8, Math.min(anchor.y, window.innerHeight - 220)),
    }));

    return (
        <>
            <div className={"fixed inset-0 z-40"} onPointerDown={onClose} />
            <div
                style={position}
                className={
                    "fixed z-50 w-72 border border-foreground/15 bg-background p-3 shadow-lg"
                }
            >
                <CronBuilder initial={initial} floorMinutes={floorMinutes} onChange={onChange} />
            </div>
        </>
    );
}
