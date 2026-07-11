"use client";

import { useEffect, useRef } from "react";
import type { ConsoleLine } from "@/lib/interpreter";

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
    onClear,
    onClose,
}: {
    lines: ConsoleLine[];
    onClear: () => void;
    onClose: () => void;
}) {
    const scrollRef = useRef<HTMLDivElement>(null);
    // stick to the bottom only while the user is already there — scrolling
    // up to read old output must not fight the incoming lines
    const stickRef = useRef(true);

    useEffect(() => {
        const el = scrollRef.current;
        if (el && stickRef.current) el.scrollTop = el.scrollHeight;
    }, [lines]);

    return (
        <section
            className={
                "flex h-40 shrink-0 flex-col border-t border-foreground/15 bg-background font-mono text-xs"
            }
        >
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
