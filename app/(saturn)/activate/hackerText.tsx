"use client";

import { useEffect, useRef, useState } from "react";

// terminal "decode" flash: when the pointer enters the enclosing button or
// [data-hacker-host] card, the
// text flips to ascii noise and resolves back character by character, left to
// right. Runs once per hover; skipped entirely under reduced motion.
const NOISE = "!<>-_\\/[]{}=+*^?#$%&@;:~";
const DURATION = 550;

export default function HackerText({ text, flashClass = "text-green-400" }: { text: string; flashClass?: string }) {
    const [display, setDisplay] = useState(text);
    const ref = useRef<HTMLSpanElement>(null);
    const raf = useRef(0);
    const running = useRef(false);

    useEffect(() => {
        const host = ref.current?.closest("button, [data-hacker-host]");
        if (!host) return;

        const scramble = () => {
            if (running.current) return;
            if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
            running.current = true;
            const start = performance.now();
            const tick = (now: number) => {
                const t = (now - start) / DURATION;
                if (t >= 1) {
                    setDisplay(text);
                    running.current = false;
                    return;
                }
                // characters left of the sweep are solved; the rest churn as noise
                const solved = Math.floor(t * text.length);
                setDisplay(
                    text
                        .split("")
                        .map((ch, i) =>
                            i < solved || ch === " "
                                ? ch
                                : NOISE[Math.floor(Math.random() * NOISE.length)],
                        )
                        .join(""),
                );
                raf.current = requestAnimationFrame(tick);
            };
            raf.current = requestAnimationFrame(tick);
        };

        host.addEventListener("mouseenter", scramble);
        return () => {
            host.removeEventListener("mouseenter", scramble);
            cancelAnimationFrame(raf.current);
            running.current = false;
        };
    }, [text]);

    return (
        <span ref={ref} className={`transition-colors duration-200 ${flashClass}`}>
            {display}
        </span>
    );
}
