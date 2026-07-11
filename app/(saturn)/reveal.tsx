"use client";

import { useEffect, useRef } from "react";

// adds `landing-revealed` once the block first scrolls into view, driving the
// spine-draw + card-rise transitions in globals.css; fires once, then detaches
export default function Reveal({ className, children }: {
    className?: string;
    children: React.ReactNode;
}) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        // the huge top rootMargin counts anything at or above the viewport as
        // seen, so an instant jump past the block (End key, anchor) can't
        // strand it invisible — IO never fires on below→above transitions
        const io = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) {
                el.classList.add("landing-revealed");
                io.disconnect();
            }
        }, { threshold: 0, rootMargin: "100000px 0px 0px 0px" });
        io.observe(el);
        return () => io.disconnect();
    }, []);

    return (
        <div ref={ref} className={className}>
            {children}
        </div>
    );
}
