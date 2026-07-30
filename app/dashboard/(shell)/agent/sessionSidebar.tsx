"use client";

import { useState, useSyncExternalStore } from "react";
import ConfirmButton from "@/app/dashboard/confirmButton";
import { ChevronDown, Pencil } from "@/app/dashboard/icons";
import { call } from "@/lib/ipc";
import { getRunning, subscribe } from "../agentChatStore";
import RunGlyph from "./runGlyph";
import type { SessionRow } from "./sessionPicker";

// the store is client-only, so the prerendered HTML has nothing running
const none = () => "";

// remembered across navigations because the page unmounts every time the user
// visits the designer, and re-expanding a rail they collapsed reads as a bug
const KEY = "saturnChatRail";

// The collapsed width, and every leading cell's width, are ONE number. That is
// what makes the collapse a pure reveal: the glyph column is `w-10` open and
// closed, the rail is `w-10` wide, so nothing about a status dot moves while the
// width animates — only the labels to its right come and go. Change this and
// change it in all four places at once, or the dots start sliding.
const GUTTER = "flex w-10 shrink-0 items-center justify-center";

// ease-out-quint, the same curve `agent-enter` uses in globals.css: leaves fast,
// lands soft. Deliberately NOT an overshoot curve — a back-out on `width` would
// dip the rail below `w-10` on the way in and clip the glyphs it exists to show.
const SLIDE =
    "transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none";
// labels cross-fade against that slide: out immediately on collapse, in a beat
// late on expand, so the text never appears in a column too narrow to hold it
const FADE = "transition-opacity duration-200 motion-reduce:transition-none";

// Chat switcher for the dashboard page: a column down the left of the window,
// every session a row carrying a live glyph for what that chat's agent is doing —
// running, or holding a reply that landed while the user was elsewhere. Neither
// is something the dropdown this replaced could show, since a backgrounded turn
// keeps streaming.
//
// Collapsed it is a rail of nothing but those glyphs. That is the point: the
// green dot exists to be noticed without opening anything, so it has to survive
// the collapse, and a rail is also its own re-open affordance where a fully
// hidden sidebar would need a separate floating button.
//
// One markup for both states, never a branch on `open`: the labels fade and the
// width animates, but the rows, their buttons and their glyphs are the same
// elements throughout. Two markups would pop instead of slide.
//
// The caller owns the session list and the refetch; this only drives the four
// session commands.
//
// ponytail: overlaps sessionPicker.tsx by the `run` wrapper and the rename input.
// That dropdown is still the designer panel's, where a column does not fit a
// 300px aside; the duplication dies with it if the panel ever changes shape.
export default function SessionSidebar({
    sessions,
    current,
    onPick,
    onChanged,
}: {
    sessions: SessionRow[];
    current: string;
    onPick: (id: string) => void;
    onChanged: () => void;
}) {
    // safe as an initializer, with no <head> script of the kind the deleted shell
    // sidebar needed: the page renders this only once the session fetch has
    // resolved, so it never runs during hydration and cannot mismatch.
    const [open, setOpen] = useState(() => localStorage.getItem(KEY) !== "0");
    const [editing, setEditing] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    const [err, setErr] = useState("");
    const running = useSyncExternalStore(subscribe, getRunning, none);

    const toggle = () =>
        setOpen((o) => {
            localStorage.setItem(KEY, o ? "0" : "1");
            return !o;
        });

    // the pencil and the double-click open the same inline input
    const edit = (s: SessionRow) => {
        setDraft(s.name);
        setEditing(s.id);
    };

    // a label that is only there when the column is wide enough for it.
    // pointer-events-none matters: a faded-out `delete` is still a click target.
    const label = `${FADE} ${open ? "opacity-100 delay-100" : "pointer-events-none opacity-0"}`;

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

    return (
        <aside
            className={
                // overflow-hidden is what the animation needs: mid-slide the
                // labels are wider than the column they sit in
                "flex h-full shrink-0 flex-col overflow-hidden border-r " +
                "border-foreground/15 font-mono text-xs " +
                SLIDE +
                (open ? " w-56" : " w-10")
            }
        >
            <button
                type={"button"}
                aria-label={"new chat"}
                onClick={() =>
                    run(
                        call<SessionRow>("saturn_create_session", { name: null }).then((s) =>
                            onPick(s.id),
                        ),
                    )
                }
                className={
                    "flex shrink-0 cursor-pointer items-center border-b border-foreground/15 " +
                    "py-2 text-gray-400 transition-colors hover:text-foreground"
                }
            >
                <span aria-hidden className={GUTTER}>
                    +
                </span>
                <span className={`min-w-0 flex-1 truncate text-left ${label}`}>new chat</span>
            </button>

            <div className={"min-h-0 flex-1 overflow-y-auto"}>
                {sessions.map((s) => {
                    const active = s.id === current;
                    const busy = running.split(" ").includes(s.id);
                    return (
                        <div
                            key={s.id}
                            className={
                                "flex items-center " + (active ? "bg-foreground/10" : "")
                            }
                        >
                            {editing === s.id ? (
                                <>
                                    <span className={GUTTER}>
                                        <RunGlyph id={s.id} />
                                    </span>
                                    <input
                                        autoFocus
                                        value={draft}
                                        aria-label={"Chat name"}
                                        // This input has to occupy the exact box
                                        // the label it replaces sat in, or the
                                        // rest of the list jumps on rename. Two
                                        // rules, both measured:
                                        //
                                        // No border and no px — an `outline` is
                                        // painted outside the box and costs no
                                        // layout, where a border plus padding
                                        // pushed the name 5px right and grew the
                                        // row. But the offset has to be NEGATIVE:
                                        // at the default 0 the outline still
                                        // spills 1px past the row top and bottom,
                                        // which is the field reading 2px taller
                                        // than the row it lives in.
                                        //
                                        // `h-6` IS the display button's height —
                                        // its `py-1` (8px) around a text-xs line
                                        // box (16px). Without it the input is
                                        // 16px and the row collapses. Change one,
                                        // change both.
                                        className={
                                            "mr-2 h-6 min-w-0 flex-1 bg-transparent font-mono " +
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
                                </>
                            ) : (
                                <>
                                    {/* a plain button, not role="tab" — that role
                                        contracts arrow-key navigation, and the
                                        delete beside the name cannot nest inside
                                        another button anyway. The glyph is INSIDE
                                        it, so the rail's 2.5rem cell is the whole
                                        click target when the label is gone. */}
                                    <button
                                        type={"button"}
                                        aria-label={s.name}
                                        title={s.name}
                                        aria-pressed={active}
                                        aria-busy={busy}
                                        onClick={() => onPick(s.id)}
                                        // the mouse shortcut for the pencil
                                        // beside it, which is the keyboard path
                                        onDoubleClick={() => {
                                            if (active) edit(s);
                                        }}
                                        className={
                                            "flex min-w-0 flex-1 cursor-pointer items-center py-1 " +
                                            "transition-colors " +
                                            (active ? "" : "text-gray-400 hover:text-foreground")
                                        }
                                    >
                                        <span className={GUTTER}>
                                            <RunGlyph id={s.id} />
                                        </span>
                                        <span className={`min-w-0 flex-1 truncate text-left ${label}`}>
                                            {s.name}
                                        </span>
                                    </button>

                                    {/* only the open chat offers these — one pair
                                        per row would be a column of nothing but
                                        action glyphs */}
                                    {active && (
                                        <span
                                            className={
                                                `flex shrink-0 items-center gap-2 pr-2 ${label}`
                                            }
                                        >
                                            <button
                                                type={"button"}
                                                aria-label={"rename"}
                                                title={"rename"}
                                                onClick={() => edit(s)}
                                                className={
                                                    "cursor-pointer text-gray-400 transition-colors " +
                                                    "hover:text-foreground"
                                                }
                                            >
                                                <Pencil />
                                            </button>
                                            <ConfirmButton
                                                sizeClass={"text-xs"}
                                                onConfirm={() =>
                                                    run(call("saturn_delete_session", { id: s.id }))
                                                }
                                            />
                                        </span>
                                    )}
                                </>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* truncated with the full text on hover, because this has to fit the
                rail as well as the open column */}
            {err && (
                <p title={err} className={"shrink-0 truncate px-2 py-1 text-red-400"}>
                    {err}
                </p>
            )}

            <button
                type={"button"}
                aria-expanded={open}
                aria-label={open ? "collapse chats" : "expand chats"}
                onClick={toggle}
                className={
                    "flex shrink-0 cursor-pointer items-center border-t border-foreground/15 " +
                    "py-2 text-gray-400 transition-colors hover:text-foreground"
                }
            >
                {/* in the gutter like everything else, so the chevron rotates in
                    place instead of sliding across with the width */}
                <span className={GUTTER}>
                    <ChevronDown
                        aria-hidden
                        className={
                            "h-3 w-3 transition-transform duration-300 " +
                            "ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none " +
                            (open ? "rotate-90" : "-rotate-90")
                        }
                    />
                </span>
            </button>
        </aside>
    );
}
