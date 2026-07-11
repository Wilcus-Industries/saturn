"use client";

import { useEffect, useRef, useState } from "react";

// Intensity grids (hex 0-b per cell) sampled from public/art/saturn_with_tilted_rings.svg
// with its blur+dither filter applied. Rings and planet are separate layers so the
// ring characters can animate independently; ring cells occluded by the planet are zeroed.
const RINGS = [
    "0000000000000000000000000000000000000000000000000000000000000000000000000001111122222211100000",
    "0000000000000000000000000000000000000000000000000000000000000000000011223444555555544444332100",
    "0000000000000000000000000000000000000000000000000000000000000011233445555665555555554323344320",
    "0000000000000000000000000000000000000000000000000000000001223445555555555555555555555422134531",
    "0000000000000000000000000000000000000000000000000000012344555555555555555444433222245543234531",
    "0000000000000000000000000000000000000000000000000000000000555555554433222111122221124554445421",
    "0000000000000000000000000000000000000000000000000000000000000332110000000000001232235555555310",
    "0000000000000000000000000000000000000000000000000000000000000000000000000000001344455556653100",
    "0000000000000000000000000000000000000000000000000000000000000000000000000000013455555566421000",
    "0000000000000000000000000000000000000000000000000000000000000000000000000000235655555653200000",
    "0000000000000000000000000000000000000000000000000000000000000000000000000013466545565421000000",
    "0000000000000000000000000000000000000000000000000000000000000000000000001245654455542100000000",
    "0000000000000000000000000000000000000000000000000000000000000000000000124565555554210000000000",
    "0000000000000000000123000000000000000000000000000000000000000000000013466555565421000000000000",
    "0000000000000000000123450000000000000000000000000000000000000000012356655556542100000000000000",
    "0000000000000000012455550000000000000000000000000000000000000001345555455543100000000000000000",
    "0000000000000001345555550000000000000000000000000000000000001235665555554210000000000000000000",
    "0000000000000235555556532000000000000000000000000000000001245555555554310000000000000000000000",
    "0000000000124555555553210000000000000000000000000000001245565555554321000000000000000000000000",
    "0000000012455555555320000000000000000000000000000012345566555554321000000000000000000000000000",
    "0000000235655555532100000000000000000000000000012345665555554320000000000000000000000000000000",
    "0000013465555554210000000000000000000000000123456555555554310000000000000000000000000000000000",
    "0000245655555432100000000000000000000011234555655555543210000000000000000000000000000000000000",
    "0012455555533221000000000000000001123455555555555543210000000000000000000000000000000000000000",
    "0124445555322221000000000001123345556555555555432100000000000000000000000000000000000000000000",
    "0234334554211233322222334445556665555555554321000000000000000000000000000000000000000000000000",
    "1343223455422234455566666555555555555443210000000000000000000000000000000000000000000000000000",
    "1344211345555555555555455555555544321100000000000000000000000000000000000000000000000000000000",
    "0235443334555555555555555554432110000000000000000000000000000000000000000000000000000000000000",
    "0012345555555655555444322110000000000000000000000000000000000000000000000000000000000000000000",
    "0000011222222222111100000000000000000000000000000000000000000000000000000000000000000000000000",
];
const PLANET = [
    "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    "0000000000000000000000000000000000000001112233333322211000000000000000000000000000000000000000",
    "0000000000000000000000000000000000012344455555555554444332100000000000000000000000000000000000",
    "0000000000000000000000000000000012445544444444444444444445543100000000000000000000000000000000",
    "0000000000000000000000000000012345544444444444444444444445555532100000000000000000000000000000",
    "0000000000000000000000000000235544444444444444444444444455444444320000000000000000000000000000",
    "0000000000000000000000000013454444444444444444444445455544444444443100000000000000000000000000",
    "0000000000000000000000000135544444444444444444455454444444444444455310000000000000000000000000",
    "0000000000000000000000001354444444444444444545555444444444444444445531000000000000000000000000",
    "0000000000000000000000013554444444444444555544444444444444444544544553100000000000000000000000",
    "0000000000000000000000024444444444444454454444444444444444445444444444200000000000000000000000",
    "0000000000000000000000134444444445555544444444444444444444444444444445310000000000000000000000",
    "0000000000000000000000134444454555544444444444444444444444444444444445410000000000000000000000",
    "0000000000000000000000145555455454444444444444444444444444444444444455410000000000000000000000",
    "0000000000000000000000145544544444444444444444444444444444444444445445410000000000000000000000",
    "0000000000000000000000135444444444444444444444444444444444455444444445310000000000000000000000",
    "0000000000000000000000024544444444444444544444444444444445544444444444200000000000000000000000",
    "0000000000000000000000013544444444444444444444444444454544444444444453100000000000000000000000",
    "0000000000000000000000001354444444444444444444444455454444444444444531000000000000000000000000",
    "0000000000000000000000000135544444444444444444554544444444444444445310000000000000000000000000",
    "0000000000000000000000000013554444444444444454444444444444444444543100000000000000000000000000",
    "0000000000000000000000000000234444444544554444444444444444444454320000000000000000000000000000",
    "0000000000000000000000000000002345554444444444444444444444454432100000000000000000000000000000",
    "0000000000000000000000000000000013455554444444444444444455442100000000000000000000000000000000",
    "0000000000000000000000000000000000012334444444455445444332100000000000000000000000000000000000",
    "0000000000000000000000000000000000000001122233333322211000000000000000000000000000000000000000",
    "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
];

const RAMP = " .:;=+*xX#%@";
const rings = RINGS.map(row => [...row].map(c => parseInt(c, 16)));
const planet = PLANET.map(row => [...row].map(c => parseInt(c, 16)));

// full-art grid dimensions (scale=1) — moons snap their orbit to this lattice
export const ART_COLS = rings[0].length;
export const ART_ROWS = rings.length;

function hash(x: number, y: number) {
    return (((x * 73856093) ^ (y * 19349663)) >>> 0) % 97;
}

// max-pool f×f blocks — keeps thin ring strands alive at low resolution
function downsample(grid: number[][], f: number): number[][] {
    const rows = Math.ceil(grid.length / f);
    const cols = Math.ceil(grid[0].length / f);
    return Array.from({ length: rows }, (_, gy) =>
        Array.from({ length: cols }, (_, gx) => {
            let max = 0;
            for (let dy = 0; dy < f; dy++) {
                for (let dx = 0; dx < f; dx++) {
                    max = Math.max(max, grid[gy * f + dy]?.[gx * f + dx] ?? 0);
                }
            }
            return max;
        })
    );
}

const gridCache = new Map<number, [number[][], number[][]]>();
function gridsAt(scale: number): [number[][], number[][]] {
    let entry = gridCache.get(scale);
    if (!entry) {
        entry = scale === 1 ? [rings, planet] : [downsample(rings, scale), downsample(planet, scale)];
        gridCache.set(scale, entry);
    }
    return entry;
}

// returns [ringLines, planetLines] — separate layers so each can be colored independently
function frame(t: number, ringGrid: number[][], planetGrid: number[][]): [string, string] {
    const ringLines: string[] = [];
    const planetLines: string[] = [];
    for (let y = 0; y < ringGrid.length; y++) {
        let ringLine = "";
        let planetLine = "";
        for (let x = 0; x < ringGrid[0].length; x++) {
            const r = ringGrid[y][x];
            const p = planetGrid[y][x];
            if (r > 0) {
                // two traveling waves drift character density along the rings
                const wave =
                    Math.sin(x * 0.35 + y * 0.9 - t * 0.65) +
                    0.6 * Math.sin(x * 0.13 + t * 0.4 + hash(x, y));
                ringLine += RAMP[Math.max(1, Math.min(11, r + Math.round(wave * 1.8)))];
                planetLine += " ";
            } else if (p > 0) {
                // bands drift slowly across the planet, plus static grain
                const drift = Math.sin(x * 0.18 + y * 0.6 - t * 0.1);
                const grain = hash(x, y) % 5 === 0 ? 1 : 0;
                planetLine += RAMP[Math.max(1, Math.min(11, p + Math.round(drift) + grain))];
                ringLine += " ";
            } else {
                ringLine += " ";
                planetLine += " ";
            }
        }
        ringLines.push(ringLine);
        planetLines.push(planetLine);
    }
    return [ringLines.join("\n"), planetLines.join("\n")];
}

// full-viewport noise field on the same character grid as the art; cells occupied
// by ring/planet ink are left blank so nothing sits directly behind the art
function bgFrame(
    t: number,
    totalCols: number,
    totalRows: number,
    offX: number,
    offY: number,
    ringGrid: number[][],
    planetGrid: number[][],
): string {
    const lines: string[] = [];
    for (let y = 0; y < totalRows; y++) {
        let line = "";
        for (let x = 0; x < totalCols; x++) {
            const ax = x - offX;
            const ay = y - offY;
            const inked =
                ay >= 0 && ay < ringGrid.length && ax >= 0 && ax < ringGrid[0].length &&
                (ringGrid[ay][ax] > 0 || planetGrid[ay][ax] > 0);
            if (inked) {
                line += " ";
            } else {
                // faint static noise; a few cells twinkle
                const n = hash(x, y);
                let bg = n < 42 ? "." : n < 60 ? ":" : n < 68 ? "+" : " ";
                if (bg !== " " && (n * 7 + t) % 160 < 3) bg = "*";
                line += bg;
            }
        }
        lines.push(line);
    }
    return lines.join("\n");
}

// art is ~94 chars wide (~56em in monospace) — default font size scales with viewport, capped at 10px
export const DEFAULT_SIZE_CLASS = "text-[min(10px,1.6vw)]";

export default function AsciiSaturn({
    sizeClass = DEFAULT_SIZE_CLASS,
    scale = 1,
    noise = true,
}: {
    sizeClass?: string;
    // downsample factor: 1 = full art, 2/3/… = coarser grid with fewer, denser characters
    scale?: number;
    // set false to skip the background noise field (e.g. small logo marks)
    noise?: boolean;
}) {
    const [t, setT] = useState(0);
    const artRef = useRef<HTMLDivElement>(null);
    // parent-div coverage in whole cells around the art, so the bg grid stays
    // cell-aligned with the art grid and fills the section without spilling past it
    const [box, setBox] = useState<{
        dx: number;
        dy: number;
        width: number;
        height: number;
        cellsLeft: number;
        cellsTop: number;
        totalCols: number;
        totalRows: number;
    } | null>(null);

    const [ringGrid, planetGrid] = gridsAt(scale);

    useEffect(() => {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        const id = setInterval(() => setT(prev => prev + 1), 90);
        return () => clearInterval(id);
    }, []);

    useEffect(() => {
        if (!noise) return;
        const cols = ringGrid[0].length;
        const rows = ringGrid.length;
        const measure = () => {
            const el = artRef.current;
            // noise field fills the nearest [data-ascii-bounds] ancestor (fallback:
            // direct parent), so wrappers can sit between the art and the section
            const parent = el?.closest<HTMLElement>("[data-ascii-bounds]") ?? el?.parentElement;
            if (!el || !parent) return;
            const rect = el.getBoundingClientRect();
            const p = parent.getBoundingClientRect();
            const charW = rect.width / cols;
            const charH = rect.height / rows;
            const dx = rect.left - p.left;
            const dy = rect.top - p.top;
            const cellsLeft = Math.max(0, Math.ceil(dx / charW));
            const cellsTop = Math.max(0, Math.ceil(dy / charH));
            const cellsRight = Math.max(0, Math.ceil((p.right - rect.right) / charW));
            const cellsBottom = Math.max(0, Math.ceil((p.bottom - rect.bottom) / charH));
            setBox({
                dx,
                dy,
                width: p.width,
                height: p.height,
                cellsLeft,
                cellsTop,
                totalCols: cols + cellsLeft + cellsRight,
                totalRows: rows + cellsTop + cellsBottom,
            });
        };
        measure();
        window.addEventListener("resize", measure);
        return () => window.removeEventListener("resize", measure);
    }, [ringGrid]);

    const [ringText, planetText] = frame(t, ringGrid, planetGrid);
    const preClasses = `font-mono ${sizeClass} leading-none select-none`;

    return (
        <div ref={artRef} className={"relative"} role={"img"} aria-label={"Saturn"}>
            {noise && box && (
                <div
                    aria-hidden
                    className={"absolute -z-10 overflow-hidden"}
                    style={{ left: -box.dx, top: -box.dy, width: box.width, height: box.height }}
                >
                    <pre
                        className={`${preClasses} absolute text-[#D9D9D9] dark:text-[#2E2E2E]`}
                        style={{
                            left: `calc(${box.dx}px - ${box.cellsLeft}ch)`,
                            top: `calc(${box.dy}px - ${box.cellsTop}em)`,
                        }}
                    >
                        {bgFrame(t, box.totalCols, box.totalRows, box.cellsLeft, box.cellsTop, ringGrid, planetGrid)}
                    </pre>
                </div>
            )}
            <pre aria-hidden className={`${preClasses} text-[#6E7780] dark:text-[#8E979F]`}>
                {planetText}
            </pre>
            <pre aria-hidden className={`${preClasses} absolute inset-0 text-[#26221D] dark:text-[#F5F1E8]`}>
                {ringText}
            </pre>
        </div>
    );
}
