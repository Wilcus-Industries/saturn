"use client";

import { useEffect, useRef } from "react";
import { ART_COLS, ART_ROWS, DEFAULT_SIZE_CLASS } from "./asciiSaturn";

export type MoonSpec = {
    // orbit half-axes as fractions of the art width; small ry keeps the
    // ellipse flat so it reads as a ring-plane orbit seen edge-on
    rx: number;
    ry: number;
    // screen-space rotation (radians) aligning the orbit with the ring tilt
    tilt: number;
    // seconds per revolution
    period: number;
    // radians; where on the orbit the moon starts
    phase: number;
    // ascii sprites from farthest to nearest — depth swaps the sprite instead
    // of scaling, so the moon always sits on the art's character grid
    glyphs: string[];
};

const TWO_PI = Math.PI * 2;

function measure(glyph: string) {
    const lines = glyph.split("\n");
    return { text: glyph, cols: Math.max(...lines.map(l => l.length)), rows: lines.length };
}

export default function Moon({ spec, visible }: { spec: MoonSpec; visible: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    const preRef = useRef<HTMLPreElement>(null);

    useEffect(() => {
        const el = ref.current;
        const pre = preRef.current;
        const parent = el?.parentElement;
        if (!el || !pre || !parent) return;
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const variants = spec.glyphs.map(measure);

        let { width, height } = parent.getBoundingClientRect();
        let prev = "";
        const ro = new ResizeObserver(entries => {
            ({ width, height } = entries[0].contentRect);
            prev = ""; // cell size changed — force a redraw at the new metrics
            if (reduced) {
                // no rAF loop is running — schedule the one-shot redraw here
                cancelAnimationFrame(raf);
                raf = requestAnimationFrame(draw);
            }
        });
        ro.observe(parent);

        const cosT = Math.cos(spec.tilt);
        const sinT = Math.sin(spec.tilt);
        const start = performance.now();
        let raf = 0;
        const draw = (now: number) => {
            const angle = spec.phase + (reduced ? 0 : ((now - start) / 1000 / spec.period) * TWO_PI);
            const x = Math.cos(angle) * spec.rx * width;
            const y = Math.sin(angle) * spec.ry * width;
            const depth = (Math.sin(angle) + 1) / 2; // 1 = nearest to viewer
            const vi = Math.min(variants.length - 1, Math.floor(depth * variants.length));
            const v = variants[vi];
            // snap to whole art cells so the moon steps character by character,
            // staying on the same lattice as the planet/ring glyphs
            const charW = width / ART_COLS;
            const charH = height / ART_ROWS;
            const cellX = Math.round((width / 2 + x * cosT - y * sinT) / charW - v.cols / 2);
            const cellY = Math.round((height / 2 + x * sinT + y * cosT) / charH - v.rows / 2);
            const front = depth > 0.5;
            const key = `${cellX},${cellY},${vi},${front}`;
            if (key !== prev) {
                prev = key;
                el.style.transform = `translate(${cellX * charW}px, ${cellY * charH}px)`;
                el.style.opacity = `${variants.length > 1 ? 0.55 + 0.45 * (vi / (variants.length - 1)) : 1}`;
                // far half of the orbit slips behind the planet glyphs, near half in front
                el.style.zIndex = front ? "5" : "-5";
                pre.textContent = v.text;
            }
            if (!reduced) raf = requestAnimationFrame(draw);
        };
        raf = requestAnimationFrame(draw);
        return () => {
            cancelAnimationFrame(raf);
            ro.disconnect();
        };
    }, [spec]);

    // SSR renders the sprite the first client frame will pick, so there is no
    // glyph swap on hydration; opacity stays 0 until the first frame positions it
    const depth0 = (Math.sin(spec.phase) + 1) / 2;
    const glyph0 = spec.glyphs[Math.min(spec.glyphs.length - 1, Math.floor(depth0 * spec.glyphs.length))];

    return (
        <div ref={ref} aria-hidden className={"absolute top-0 left-0 opacity-0"}>
            <pre
                ref={preRef}
                className={`font-mono ${DEFAULT_SIZE_CLASS} leading-none select-none
                            text-[#4E5760] dark:text-[#C9CFD4]
                            transition-opacity duration-700 ease-out
                            ${visible ? "opacity-100" : "opacity-0"}`}
            >
                {glyph0}
            </pre>
        </div>
    );
}
