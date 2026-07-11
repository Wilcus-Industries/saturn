"use client";

import { usePathname } from "next/navigation";
import AsciiSaturn from "./asciiSaturn";
import Moon, { type MoonSpec } from "./moon";

// one moon per onboarding step — add a spec here (and bump the route's count
// below) when a new step lands; stagger phase/period so moons don't overlap
const MOONS: MoonSpec[] = [
    // rings reach rx 0.5 — keep moons at rx >= 0.7 so a clear band of empty
    // sky separates each orbit from the ring tips
    {
        rx: 0.75, ry: 0.3, tilt: -0.49, period: 10, phase: 2.1,
        // single sprite — constant size all the way around the orbit; depth
        // still reads from the far half slipping behind the planet glyphs
        glyphs: [" :%x:\nx%@@%\n:%@@x\n :x:."],
    },
    {
        // same orbit as the first moon (matching rx/ry/tilt/period) — only the
        // phase differs (offset by π) so the two ride opposite sides of the path
        rx: 0.75, ry: 0.3, tilt: -0.49, period: 10, phase: 2.1 + Math.PI,
        glyphs: [" :%:\n:%@x\n :x:"],
    },
];

// how many moons are in the sky on each route — one per onboarding step
const MOON_COUNT: Record<string, number> = {
    "/": 0,
    "/onboard": 1,
    "/activate": 2,
};

export default function SaturnScene() {
    const pathname = usePathname();
    const count = MOON_COUNT[pathname] ?? 0;

    return (
        // named so route view-transitions leave the scene live instead of
        // snapshotting it (see globals.css) — the art keeps animating mid-swap
        <div style={{ viewTransitionName: "saturn-scene" }} className={"relative"}>
            <AsciiSaturn />
            {MOONS.map((spec, i) => (
                <Moon key={i} spec={spec} visible={i < count} />
            ))}
        </div>
    );
}
