"use client";

import { useEffect, useRef, type ReactNode } from "react";

// Shared shell for every dashboard modal. Native <dialog> + showModal(), so
// Escape, the backdrop, the focus trap and top-layer stacking come from the
// platform instead of hand-rolled listeners/z-index; the close event (fired by
// Escape as much as by our own close()) drives onClose so React state stays in
// sync with the element. Children mount only while open — modals host child
// components (emoji grid, tool list editor) whose internal state must start
// fresh from their `initial` props on every open.
export default function Modal({
    open,
    onClose,
    className = "max-w-md",
    children,
}: {
    open: boolean;
    onClose: () => void;
    className?: string;
    children: ReactNode;
}) {
    const ref = useRef<HTMLDialogElement>(null);

    useEffect(() => {
        const dialog = ref.current;
        if (!dialog) return;
        if (open && !dialog.open) dialog.showModal();
        else if (!open && dialog.open) dialog.close();
    }, [open]);

    return (
        <dialog
            ref={ref}
            onClose={onClose}
            // a click whose target is the dialog element itself landed on the
            // backdrop, never on the panel below
            onClick={(e) => {
                if (e.target === ref.current) onClose();
            }}
            // preflight already zeroes the UA border/padding/margin; m-auto
            // restores the centering that margin:auto gives a modal dialog, and
            // the UA's Canvas background/color still need overriding
            className={`m-auto w-[calc(100%-2rem)] bg-transparent text-foreground
                backdrop:bg-background/80 ${className}`}
        >
            <div
                className={"max-h-[85vh] overflow-y-auto border border-foreground/15 bg-background p-6"}
            >
                {open && children}
            </div>
        </dialog>
    );
}
