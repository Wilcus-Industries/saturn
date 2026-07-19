"use client";

import { useEffect, useState } from "react";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// braille-frame busy glyph; stays on the first frame under reduced motion
export default function Spinner({ className }: { className?: string }) {
    const [frame, setFrame] = useState(0);

    useEffect(() => {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
        return () => clearInterval(id);
    }, []);

    return (
        <span aria-hidden className={className}>
            {FRAMES[frame]}
        </span>
    );
}
