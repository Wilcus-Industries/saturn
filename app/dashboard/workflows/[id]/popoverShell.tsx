"use client";

import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

// distance the panel keeps from every viewport edge when clamped
const MARGIN = 8;

// Shared fixed-position popover shell for the designer's anchored popovers
// (cronPopover / toolPickerPopover / pathPicker). Renders a z-40 backdrop that
// swallows canvas events (pan/zoom frozen) and closes on click, plus a z-50
// panel anchored near `anchor`.
//
// Positioning is measure-then-clamp-ONCE: the panel first paints invisible at
// the raw anchor so we can read its real size, then a useLayoutEffect (run once
// at mount) clamps it fully into the viewport — MARGIN px from every edge — and
// freezes there. The backdrop stops the anchor from going stale, so the clamp
// never needs to be reactive. This replaces the old per-popover hardcoded flip
// constants (cron ~220, tools ~420, pathPicker ~328) with a real measurement,
// so panels of any height land on-screen from any anchor.
//
// `className` carries the panel's own styling (border/bg/size/font); the shell
// owns `fixed z-50` and the frozen left/top.
export default function PopoverShell({
    anchor,
    className,
    onClose,
    children,
}: {
    anchor: { x: number; y: number };
    className: string;
    onClose: () => void;
    children: ReactNode;
}) {
    const panelRef = useRef<HTMLDivElement>(null);
    // null until measured: the panel renders invisible at the raw anchor for one
    // frame, then this fills in and it becomes visible clamped into view
    const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

    useLayoutEffect(() => {
        const el = panelRef.current;
        if (!el) return;
        const { width, height } = el.getBoundingClientRect();
        setPosition({
            left: Math.max(MARGIN, Math.min(anchor.x, window.innerWidth - width - MARGIN)),
            top: Math.max(MARGIN, Math.min(anchor.y, window.innerHeight - height - MARGIN)),
        });
        // clamp once at mount — deliberately not reactive to anchor changes
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <>
            <div className={"fixed inset-0 z-40"} onPointerDown={onClose} />
            <div
                ref={panelRef}
                style={
                    position
                        ? { left: position.left, top: position.top }
                        : { left: anchor.x, top: anchor.y, visibility: "hidden" }
                }
                className={`fixed z-50 ${className}`}
            >
                {children}
            </div>
        </>
    );
}
