"use client";

import { type ReactNode, useEffect, useState } from "react";
import ActionButton from "@/app/dashboard/actionButton";

// Shared chrome for the dashboard's create/edit modals. Owns open/close +
// Escape + the backdrop/panel + a <form> whose action result surfaces inline
// (undefined = success → close; { error } = stay open, show it). Each modal
// passes its trigger (a render prop, so it can call `open`), its title / submit
// label / save action, and its fields as children — the fields diverge too much
// to live here. `onOpen` resets the caller's controlled field state on open.
export default function ModalShell({
    trigger,
    title,
    submitLabel,
    action,
    onOpen,
    wide = false,
    children,
}: {
    trigger: (open: () => void) => ReactNode;
    title: string;
    submitLabel: string;
    action: (formData: FormData) => Promise<{ error: string } | undefined>;
    onOpen?: () => void;
    wide?: boolean; // wider + scrollable panel (the mcp server form)
    children: ReactNode;
}) {
    const [open, setOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const openModal = () => {
        setError(null);
        onOpen?.();
        setOpen(true);
    };

    // Escape closes; listener only lives while the modal is open
    useEffect(() => {
        if (!open) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [open]);

    return (
        <>
            {trigger(openModal)}

            {open && (
                <div
                    className={"fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"}
                    onClick={() => setOpen(false)}
                >
                    {/* clicks inside the panel must not reach the backdrop */}
                    <div
                        className={
                            wide
                                ? `max-h-[85vh] w-full max-w-lg overflow-y-auto border border-foreground/15 bg-background p-6`
                                : `w-full max-w-md border border-foreground/15 bg-background p-6`
                        }
                        onClick={(e) => e.stopPropagation()}
                    >
                        <form
                            action={async (formData) => {
                                setError(null);
                                const result = await action(formData);
                                if (result) {
                                    setError(result.error);
                                    return;
                                }
                                // create actions redirect instead of returning;
                                // that throw propagates past here, never closing
                                setOpen(false);
                            }}
                            className={"flex flex-col gap-4"}
                        >
                            <h2 className={"font-mono text-xl"}>{title}</h2>

                            {children}

                            {error && <p className={"font-mono text-xs text-red-400"}>{error}</p>}

                            <ActionButton
                                className={`self-end rounded-full border border-foreground px-4 py-2
                                    font-mono text-sm transition-colors duration-200
                                    hover:bg-foreground hover:text-background`}
                            >
                                {submitLabel}
                            </ActionButton>
                        </form>
                    </div>
                </div>
            )}
        </>
    );
}
