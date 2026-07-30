"use client";

import { useEffect, useRef, useState } from "react";
import ConfirmButton from "@/app/dashboard/confirmButton";
import { ChevronDown } from "@/app/dashboard/icons";
import { call } from "@/lib/ipc";
import RunGlyph from "./runGlyph";

// saturn::SessionRow, camelCase over IPC
export type SessionRow = {
    id: string;
    name: string;
    createdAt: number;
    updatedAt: number;
};

// Chat switcher for both Saturn surfaces: the dashboard page's header row and
// (compact) the designer's docked panel header. The caller owns the session list
// and the refetch — this only drives the four session commands.
export default function SessionPicker({
    sessions,
    current,
    onPick,
    onChanged,
    compact,
}: {
    sessions: SessionRow[];
    current: string;
    onPick: (id: string) => void;
    onChanged: () => void;
    compact?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [editing, setEditing] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    const [err, setErr] = useState("");
    const rootRef = useRef<HTMLDivElement>(null);

    // same document-listener dismissal as the composer's pickers — a backdrop
    // div gets trapped under the hero's entrance-animation stacking context
    useEffect(() => {
        if (!open) return;
        const onDown = (e: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("pointerdown", onDown);
        return () => document.removeEventListener("pointerdown", onDown);
    }, [open]);

    // every mutation reports its own failure — a taken name is the common one
    // and the user typed it, so it cannot fail silently
    const run = (p: Promise<unknown>) =>
        void p.then(
            () => {
                setErr("");
                onChanged();
            },
            (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
        );

    const name = sessions.find((s) => s.id === current)?.name ?? "chat";

    return (
        <div ref={rootRef} className={"relative"}>
            <button
                type={"button"}
                aria-haspopup={"listbox"}
                aria-expanded={open}
                onClick={() => setOpen((o) => !o)}
                className={
                    "flex cursor-pointer items-center gap-1.5 py-1 px-1 font-mono text-xs " +
                    "text-gray-400 transition-colors hover:text-foreground " +
                    (open ? "text-foreground" : "")
                }
            >
                {/* closed, the trigger is the only thing the panel header shows —
                    so it carries the open chat's glyph, same one the rows use */}
                <RunGlyph id={current} />
                <span className={compact ? "max-w-24 truncate" : "max-w-48 truncate"}>{name}</span>
                <ChevronDown
                    aria-hidden
                    className={`h-2.5 w-2.5 transition-transform ${open ? "rotate-180" : ""}`}
                />
            </button>

            {open && (
                <div
                    role={"listbox"}
                    aria-label={"Chat"}
                    className={
                        // compact = the designer's docked panel, where the button
                        // sits at the right edge of a 300px-minimum aside: a
                        // left-aligned w-64 dropdown would hang off it
                        `absolute top-full ${compact ? "right-0" : "left-0"} ` +
                        "z-20 mt-2 flex max-h-72 w-64 flex-col " +
                        "border border-foreground/15 bg-background " +
                        "shadow-[0_12px_40px_-12px_rgba(0,0,0,0.45)]"
                    }
                >
                    <button
                        type={"button"}
                        onClick={() => {
                            setOpen(false);
                            run(
                                call<SessionRow>("saturn_create_session", { name: null }).then((s) =>
                                    onPick(s.id),
                                ),
                            );
                        }}
                        className={
                            "cursor-pointer border-b border-foreground/15 p-2 text-left font-mono " +
                            "text-xs transition-colors hover:bg-foreground hover:text-background"
                        }
                    >
                        + new chat
                    </button>

                    <div className={"overflow-y-auto"}>
                        {sessions.map((s) => (
                            <div
                                key={s.id}
                                className={
                                    "group flex items-center gap-2 p-2 font-mono text-xs " +
                                    (s.id === current ? "bg-foreground/10" : "")
                                }
                            >
                                <RunGlyph id={s.id} />
                                {editing === s.id ? (
                                    <input
                                        autoFocus
                                        value={draft}
                                        aria-label={"Chat name"}
                                        // outline over border, no px, negative
                                        // offset — same reason as
                                        // sessionSidebar.tsx: none of it costs
                                        // layout, so the input sits on the pixels
                                        // the option label just left instead of
                                        // shifting the row. No height here: this
                                        // row's padding is on the wrapper, so the
                                        // input's natural text-xs line box is
                                        // already the button's 16px.
                                        className={
                                            "min-w-0 flex-1 bg-transparent font-mono " +
                                            "text-xs outline-1 -outline-offset-1 outline-foreground/30"
                                        }
                                        onChange={(e) => setDraft(e.target.value)}
                                        onBlur={() => setEditing(null)}
                                        onKeyDown={(e) => {
                                            if (e.key === "Escape") setEditing(null);
                                            if (e.key !== "Enter") return;
                                            setEditing(null);
                                            run(
                                                call("saturn_rename_session", {
                                                    id: s.id,
                                                    name: draft,
                                                }),
                                            );
                                        }}
                                    />
                                ) : (
                                    <button
                                        type={"button"}
                                        role={"option"}
                                        aria-selected={s.id === current}
                                        onClick={() => {
                                            onPick(s.id);
                                            setOpen(false);
                                        }}
                                        className={"min-w-0 flex-1 cursor-pointer truncate text-left"}
                                    >
                                        {s.name}
                                    </button>
                                )}
                                <button
                                    type={"button"}
                                    onClick={() => {
                                        setDraft(s.name);
                                        setEditing(s.id);
                                    }}
                                    className={"shrink-0 text-gray-400 hover:text-foreground"}
                                >
                                    rename
                                </button>
                                <ConfirmButton
                                    sizeClass={"text-xs"}
                                    onConfirm={() => run(call("saturn_delete_session", { id: s.id }))}
                                />
                            </div>
                        ))}
                    </div>

                    {err && (
                        <p className={"border-t border-foreground/15 p-2 font-mono text-xs text-red-400"}>
                            {err}
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}
