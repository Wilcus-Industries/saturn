"use client";

import { useEffect, useRef } from "react";
import type { ConsoleLine } from "@/lib/interpreter";

// resize bounds: never smaller than roughly the header + a few lines, never
// taller than most of the viewport (topbar + some canvas must stay visible)
const MIN_HEIGHT = 96;
const MAX_HEIGHT_FRACTION = 0.7;

const LINE_STYLES: Record<ConsoleLine["kind"], string> = {
    print: "text-foreground",
    info: "text-gray-400",
    warn: "text-yellow-600 dark:text-yellow-400",
    error: "text-red-500",
    image: "text-foreground",
};

// output panel for designer test runs; named ConsolePanel to avoid
// shadowing the global console
export default function ConsolePanel({
    lines,
    height,
    onResize,
    onClear,
    onClose,
}: {
    lines: ConsoleLine[];
    height: number;
    onResize: (height: number) => void;
    onClear: () => void;
    onClose: () => void;
}) {
    const scrollRef = useRef<HTMLDivElement>(null);
    // stick to the bottom only while the user is already there — scrolling
    // up to read old output must not fight the incoming lines
    const stickRef = useRef(true);
    // in-flight top-edge resize; the handle holds pointer capture so the
    // gesture keeps tracking even when the pointer leaves the handle
    const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null);

    useEffect(() => {
        const el = scrollRef.current;
        if (el && stickRef.current) el.scrollTop = el.scrollHeight;
    }, [lines]);

    return (
        <section
            style={{ height }}
            className={
                "relative flex shrink-0 flex-col border-t border-foreground/15 bg-background font-mono text-xs"
            }
        >
            <div
                onPointerDown={(e) => {
                    resizeRef.current = { startY: e.clientY, startHeight: height };
                    e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                    const drag = resizeRef.current;
                    if (!drag) return;
                    const max = Math.round(window.innerHeight * MAX_HEIGHT_FRACTION);
                    const next = drag.startHeight + drag.startY - e.clientY;
                    onResize(Math.min(max, Math.max(MIN_HEIGHT, next)));
                }}
                onPointerUp={() => (resizeRef.current = null)}
                onPointerCancel={() => (resizeRef.current = null)}
                aria-hidden
                className={
                    "absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize touch-none transition-colors hover:bg-foreground/20 active:bg-foreground/20"
                }
            />
            <div className={"flex items-center gap-4 border-b border-foreground/15 px-3 py-1.5"}>
                <h2 className={"text-[10px] uppercase tracking-wider text-gray-400"}>console</h2>
                <button
                    type={"button"}
                    onClick={onClear}
                    className={"ml-auto text-gray-400 transition-colors hover:text-foreground"}
                >
                    clear
                </button>
                <button
                    type={"button"}
                    onClick={onClose}
                    aria-label={"close console"}
                    className={"text-gray-400 transition-colors hover:text-foreground"}
                >
                    ×
                </button>
            </div>
            <div
                ref={scrollRef}
                onScroll={(e) => {
                    const el = e.currentTarget;
                    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
                }}
                className={"min-h-0 flex-1 overflow-y-auto px-3 py-1"}
            >
                {lines.length === 0 && <div className={"text-gray-400"}>(no output)</div>}
                {lines.map((line, i) =>
                    line.kind === "image" ? (
                        // eslint-disable-next-line @next/next/no-img-element -- data URL, not an optimizable asset
                        <img
                            key={i}
                            src={line.text}
                            alt={"output image"}
                            className={
                                "my-1 max-h-32 max-w-full border border-foreground/15 object-contain"
                            }
                        />
                    ) : (
                        <div
                            key={i}
                            className={`whitespace-pre-wrap break-words ${LINE_STYLES[line.kind]}`}
                        >
                            {line.text}
                        </div>
                    ),
                )}
            </div>
        </section>
    );
}
