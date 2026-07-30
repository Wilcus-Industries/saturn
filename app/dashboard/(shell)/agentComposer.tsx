"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DEFAULT_MODEL } from "@/lib/agent";
import { ArrowUp, ChevronDown, CodeBranch, Folder, Stop } from "@/app/dashboard/icons";
import ModelLogo from "@/app/dashboard/workflows/designer/modelLogo";
import { call } from "@/lib/ipc";
import { getDraft, getSessionId, setDraft, subscribe } from "./agentChatStore";
// type-only import — compile-erased, safe in a client component
import type { ProviderModels } from "@/app/dashboard/workflows/designer/designer";

// shown when no provider is connected, or every fetch degraded to [] — the
// selector still renders (the send would fail, and the chat says why above)
const FALLBACK_MODELS: ProviderModels[] = [
    {
        provider: "openrouter",
        label: "OpenRouter",
        models: [
            { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", outputModalities: ["text"], supportsReasoning: true },
            { id: "anthropic/claude-opus-4.1", name: "Claude Opus 4.1", outputModalities: ["text"], supportsReasoning: true },
            { id: "openai/gpt-5", name: "GPT-5", outputModalities: ["text"], supportsReasoning: true },
            { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", outputModalities: ["text"], supportsReasoning: true },
        ],
    },
];

const DEFAULT_EFFORT = "medium";
const MAX_LISTED = 120;

// mirrors the agent node's reasoning select (executeAgentTurn allowlist)
const REASONING_LEVELS = ["off", "low", "medium", "high"] as const;

// last pick, remembered across reloads and the dashboard ⇄ designer handoff.
// localStorage, not a cookie: there is no server left to read one. Read back in
// a mount effect rather than a <head> script — the composer already enters on a
// 120ms delay (.agent-enter-late), so the one-frame swap is invisible, and head
// scripts are for things that would shift layout.
const remember = (name: string, value: string) => {
    localStorage.setItem(name, value);
};

// OpenRouter names read "Author: Model" — the trigger chip drops the author
// (the logo already says who made it); list rows keep the full name
const shortName = (name: string) => name.replace(/^[^:]+:\s*/, "");

// The last two segments identify a folder; the ancestors rarely do. Clipped
// here rather than by CSS truncation, which eats the tail — the useful half —
// and rather than by direction:rtl, which reorders the neutral leading "~/".
// The title attribute carries the whole path either way.
const shortPath = (path: string) => {
    const parts = path.split("/");
    return parts.length <= 3 ? path : `…/${parts.slice(-2).join("/")}`;
};

// composer for the Agent chat — owns the model + reasoning selectors, the
// working-directory chip, and hands the message text up via onSend; the parent
// (agentChat.tsx) owns the transcript
export default function AgentComposer({
    models,
    onSend,
    streaming,
    onStop,
}: {
    models: ProviderModels[];
    onSend: (text: string, model: string, reasoning: string) => void;
    streaming: boolean;
    onStop: () => void;
}) {
    // the textarea owns the value while mounted; the store keeps the copy that
    // outlives this mount, per session — a route change unmounts the whole
    // composer and switching chats has to swap drafts, not merge them
    const [value, setValue] = useState(getDraft);
    const [model, setModel] = useState(DEFAULT_MODEL);
    const [reasoning, setReasoning] = useState<string>(DEFAULT_EFFORT);
    const [open, setOpen] = useState(false);
    const [effortOpen, setEffortOpen] = useState(false);
    const [q, setQ] = useState("");
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const pickersRef = useRef<HTMLDivElement>(null);

    // the working directory is per SESSION, not a localStorage pref like the two
    // above: it is where run_command starts and the only tree it may write to,
    // so it belongs to the conversation that will act in it. Read from the store
    // rather than taken as a prop — agentChat.tsx does not carry the id, and
    // both of its mount points already share this module state.
    const sessionId = useSyncExternalStore(subscribe, getSessionId, () => "");
    const [cwd, setCwd] = useState("");
    const [cwdError, setCwdError] = useState("");
    // the branch in that directory, or "" when it is not a repository. Two
    // worktrees of one repo clip to nearly the same path in the chip above, and
    // this is what tells them apart.
    const [branch, setBranch] = useState("");

    // swap in the new chat's draft. Not merged with the cwd effect below: that
    // one bails on a blank session and this still has to clear the box.
    useEffect(() => {
        /* eslint-disable-next-line react-hooks/set-state-in-effect -- the draft belongs to a session id that is only known after mount */
        setValue(getDraft());
    }, [sessionId]);

    useEffect(() => {
        if (!sessionId) return;
        let live = true;
        void call<string>("saturn_cwd", { sessionId })
            .then((d) => void (live && setCwd(d)))
            // a directory that will not resolve is the chip's own problem to
            // show, not a reason to break the composer
            .catch(() => void (live && setCwd("")));
        // same trip, same guard: a missing branch just means no line
        void call<string>("saturn_branch", { sessionId })
            .then((b) => void (live && setBranch(b)))
            .catch(() => void (live && setBranch("")));
        return () => void (live = false);
    }, [sessionId]);

    // `plugin:dialog|open` directly rather than @tauri-apps/plugin-dialog: the
    // npm package is a wrapper over this one invoke, and `call` already is one.
    // Returns null when the user cancels — leave the directory alone.
    const pickCwd = useCallback(async () => {
        if (!sessionId) return;
        // the chip lives inside pickersRef, so the outside-click dismissal does
        // not fire for it — and a popover left open behind a modal native panel
        // reads as the app having hung
        setOpen(false);
        setEffortOpen(false);
        setCwdError("");
        try {
            const picked = await call<string | null>("plugin:dialog|open", {
                options: { directory: true, multiple: false, recursive: false },
            });
            if (typeof picked !== "string") return;
            await call("saturn_set_cwd", { sessionId, cwd: picked });
            setCwd(await call<string>("saturn_cwd", { sessionId }));
            setBranch(await call<string>("saturn_branch", { sessionId }));
        } catch (err) {
            setCwdError(err instanceof Error ? err.message : "could not set the directory");
        }
    }, [sessionId]);

    // the saved pick. Deliberately a mount effect rather than a lazy useState
    // initializer: this page is prerendered by the static export, so reading
    // localStorage during the first render would either crash the build or
    // hydrate against different HTML. It lands one frame late, underneath the
    // composer's own 120ms .agent-enter-late entrance, so nothing is visible.
    useEffect(() => {
        /* eslint-disable react-hooks/set-state-in-effect -- see above: a client-only value that cannot be read during render */
        const savedModel = localStorage.getItem("agentModel");
        if (savedModel) setModel(savedModel);
        const savedEffort = localStorage.getItem("agentEffort");
        if (savedEffort) setReasoning(savedEffort);
        /* eslint-enable react-hooks/set-state-in-effect */
    }, []);

    // outside-click dismissal via document listener — a fixed backdrop div
    // gets trapped under the hero's entrance-animation stacking context
    useEffect(() => {
        if (!open && !effortOpen) return;
        const onDown = (e: PointerEvent) => {
            if (pickersRef.current && !pickersRef.current.contains(e.target as Node)) {
                setOpen(false);
                setQ("");
                setEffortOpen(false);
            }
        };
        document.addEventListener("pointerdown", onDown);
        return () => document.removeEventListener("pointerdown", onDown);
    }, [open, effortOpen]);

    const all = models.some((p) => p.models.length > 0) ? models : FALLBACK_MODELS;
    const selected = useMemo(
        () => all.flatMap((p) => p.models).find((m) => m.id === model),
        [all, model],
    );

    // search and the MAX_LISTED cut both run PER PROVIDER — one flat slice would
    // let OpenRouter's hundreds of rows push Claude Code's section off entirely.
    // A group that matches nothing is dropped, so no bare heading ever renders.
    const listed = useMemo(() => {
        const needle = q.trim().toLowerCase();
        const hits = all.map((p) => ({
            label: p.label,
            rows: needle
                ? p.models.filter(
                      (m) =>
                          m.id.toLowerCase().includes(needle) ||
                          m.name.toLowerCase().includes(needle),
                  )
                : p.models,
        }));
        return {
            groups: hits
                .map((g) => ({ label: g.label, rows: g.rows.slice(0, MAX_LISTED) }))
                .filter((g) => g.rows.length > 0),
            more: hits.reduce((n, g) => n + Math.max(0, g.rows.length - MAX_LISTED), 0),
        };
    }, [all, q]);

    const empty = value.trim() === "";

    // grow with the content. Driven off `value` rather than onInput so a draft
    // restored on mount or on a chat switch gets its height too, instead of
    // arriving as a one-row box with a scrollbar.
    const resize = useCallback(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = "auto";
        if (value !== "") el.style.height = `${el.scrollHeight}px`;
    }, [value]);
    useEffect(resize, [resize]);

    function submit() {
        if (empty || streaming) return;
        onSend(value.trim(), model, reasoning);
        write("");
    }

    // the box and the store move together — the store copy is the one that
    // survives this component being unmounted by a route change
    function write(next: string) {
        setValue(next);
        setDraft(next);
    }

    function pick(id: string) {
        setModel(id);
        remember("agentModel", id);
        setOpen(false);
        setQ("");
    }

    // the drag scrub calls this on every pointermove — skip the no-op so a
    // single drag writes one entry per stop crossed, not one per frame
    function chooseEffort(next: string) {
        if (next === reasoning) return;
        setReasoning(next);
        remember("agentEffort", next);
    }

    // dot centers as track fractions — every dot centered in its flex-1 cell
    const anchors = REASONING_LEVELS.map((_, i, a) => (i + 0.5) / a.length);

    function effortFromPointer(e: React.PointerEvent<HTMLDivElement>) {
        const rect = e.currentTarget.getBoundingClientRect();
        const t = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        let best = 0;
        anchors.forEach((a, i) => {
            if (Math.abs(t - a) < Math.abs(t - anchors[best])) best = i;
        });
        chooseEffort(REASONING_LEVELS[best]);
    }

    return (
        <form
            className={"agent-enter-late mx-auto flex w-full max-w-2xl flex-col gap-2 pb-2"}
            onSubmit={(e) => {
                e.preventDefault();
                submit();
            }}
        >
            <div
                className={
                    "flex items-end gap-2 border border-foreground/15 bg-background p-2 " +
                    "transition-[border-color,box-shadow] focus-within:border-foreground/40 " +
                    "focus-within:shadow-[0_8px_30px_-12px_rgba(0,0,0,0.35)]"
                }
            >
                <textarea
                    ref={textareaRef}
                    rows={1}
                    value={value}
                    placeholder={"Message Saturn Agent…"}
                    aria-label={"Message Saturn Agent"}
                    className={
                        "max-h-40 w-full resize-none overflow-y-auto bg-transparent p-1 " +
                        "font-mono text-sm outline-none placeholder:text-gray-400"
                    }
                    onChange={(e) => write(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            submit();
                        }
                    }}
                />
                {streaming ? (
                    <button
                        type={"button"}
                        onClick={onStop}
                        aria-label={"Stop generating"}
                        className={
                            "shrink-0 border border-foreground/15 p-2 text-sm transition-colors " +
                            "hover:bg-foreground hover:text-background"
                        }
                    >
                        <Stop />
                    </button>
                ) : (
                    <button
                        type={"submit"}
                        disabled={empty}
                        aria-label={"Send message"}
                        className={
                            "shrink-0 border border-foreground/15 p-2 text-sm transition-opacity " +
                            "hover:bg-foreground hover:text-background disabled:opacity-40 " +
                            "disabled:hover:bg-transparent disabled:hover:text-current"
                        }
                    >
                        <ArrowUp />
                    </button>
                )}
            </div>

            <div ref={pickersRef} className={"relative flex items-center"}>
                <button
                    type={"button"}
                    aria-haspopup={"listbox"}
                    aria-expanded={open}
                    title={model}
                    onClick={() => {
                        setOpen((o) => !o);
                        setEffortOpen(false);
                    }}
                    className={
                        "flex cursor-pointer items-center gap-1.5 py-1 px-1 font-mono " +
                        "text-xs text-gray-400 transition-colors hover:text-foreground " +
                        (open ? "text-foreground" : "")
                    }
                >
                    <span>{shortName(selected?.name ?? model)}</span>
                    <span className={"shrink-0 overflow-hidden rounded-full"}>
                        <ModelLogo slug={model} name={selected?.name ?? model} size={16} />
                    </span>
                    <ChevronDown
                        aria-hidden
                        className={`h-2.5 w-2.5 transition-transform ${open ? "rotate-180" : ""}`}
                    />
                </button>

                {open && (
                    <>
                        <div
                            role={"listbox"}
                            aria-label={"Model"}
                            className={
                                "absolute bottom-full left-0 z-20 mb-2 flex max-h-72 w-72 " +
                                "flex-col border border-foreground/15 bg-background " +
                                "shadow-[0_12px_40px_-12px_rgba(0,0,0,0.45)]"
                            }
                        >
                            <input
                                autoFocus
                                value={q}
                                placeholder={"search models…"}
                                aria-label={"Search models"}
                                className={
                                    "border-b border-foreground/15 bg-transparent p-2 font-mono " +
                                    "text-xs outline-none placeholder:text-gray-400"
                                }
                                onChange={(e) => setQ(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Escape") setOpen(false);
                                }}
                            />
                            <div className={"overflow-y-auto"}>
                                {/* one role="group" per provider: a listbox may
                                    own groups, and the heading itself stays out
                                    of the option flow (aria-hidden — the group's
                                    aria-label is what a reader announces) */}
                                {listed.groups.map((g) => (
                                    <div key={g.label} role={"group"} aria-label={g.label}>
                                        <h2
                                            aria-hidden
                                            className={
                                                "px-2 pb-1 pt-2 font-mono text-[10px] uppercase " +
                                                "tracking-wider text-gray-400"
                                            }
                                        >
                                            {g.label}
                                        </h2>
                                        {g.rows.map((m) => (
                                            <button
                                                key={m.id}
                                                type={"button"}
                                                role={"option"}
                                                aria-selected={m.id === model}
                                                title={m.id}
                                                onClick={() => pick(m.id)}
                                                className={
                                                    "flex w-full cursor-pointer items-center gap-2 p-2 " +
                                                    "text-left font-mono text-xs transition-colors " +
                                                    "hover:bg-foreground hover:text-background " +
                                                    (m.id === model ? "bg-foreground/10" : "")
                                                }
                                            >
                                                <span className={"min-w-0 flex-1 truncate"}>
                                                    {m.name}
                                                </span>
                                                <span
                                                    className={"shrink-0 overflow-hidden rounded-full"}
                                                >
                                                    <ModelLogo slug={m.id} name={m.name} size={16} />
                                                </span>
                                            </button>
                                        ))}
                                    </div>
                                ))}
                                {listed.groups.length === 0 && (
                                    <p className={"p-2 font-mono text-xs text-gray-400"}>
                                        no models match &quot;{q}&quot;
                                    </p>
                                )}
                                {listed.more > 0 && (
                                    <p className={"border-t border-foreground/15 p-2 font-mono text-xs text-gray-400"}>
                                        {listed.more} more — refine the search
                                    </p>
                                )}
                            </div>
                        </div>
                    </>
                )}

                {selected?.supportsReasoning && (
                    <div className={"relative ml-3 inline-flex items-center"}>
                        <button
                            type={"button"}
                            aria-haspopup={"dialog"}
                            aria-expanded={effortOpen}
                            aria-label={`Reasoning effort: ${reasoning}`}
                            onClick={() => {
                                setEffortOpen((o) => !o);
                                setOpen(false);
                            }}
                            className={
                                "flex cursor-pointer items-center gap-1.5 py-1 px-1 font-mono " +
                                "text-xs text-gray-400 transition-colors hover:text-foreground " +
                                (effortOpen ? "text-foreground" : "")
                            }
                        >
                            <span>{reasoning}</span>
                            <ChevronDown
                                aria-hidden
                                className={`h-2.5 w-2.5 transition-transform ${effortOpen ? "rotate-180" : ""}`}
                            />
                        </button>

                        {effortOpen && (
                            <>
                                <div
                                    role={"dialog"}
                                    aria-label={"Reasoning effort"}
                                    className={
                                        "absolute bottom-full left-0 z-20 mb-2 w-52 border " +
                                        "border-foreground/15 bg-background p-3 " +
                                        "shadow-[0_12px_40px_-12px_rgba(0,0,0,0.45)]"
                                    }
                                    onKeyDown={(e) => {
                                        if (e.key === "Escape") setEffortOpen(false);
                                    }}
                                >
                                    <p className={"font-mono text-xs"}>
                                        <span className={"text-gray-400"}>effort</span> {reasoning}
                                    </p>
                                    <div
                                        className={
                                            "mt-3 flex justify-between font-mono text-[10px] text-gray-400"
                                        }
                                    >
                                        <span>faster</span>
                                        <span>smarter</span>
                                    </div>
                                    {/* stop buttons carry click + keyboard; the container adds
                                        pointer-drag scrubbing (capture rides the down target) */}
                                    <div
                                        className={"relative mt-1.5 flex h-6 touch-none items-center"}
                                        onPointerDown={(e) => {
                                            // capture keeps the scrub alive when the pointer
                                            // leaves the track; invalid ids must not kill the tap
                                            try {
                                                e.currentTarget.setPointerCapture(e.pointerId);
                                            } catch {}
                                            effortFromPointer(e);
                                        }}
                                        onPointerMove={(e) => {
                                            if (e.buttons & 1) effortFromPointer(e);
                                        }}
                                    >
                                        <div
                                            aria-hidden
                                            className={"absolute inset-x-0 h-4 rounded-full bg-foreground/10"}
                                        />
                                        {REASONING_LEVELS.map((r) => {
                                            const active = r === reasoning;
                                            return (
                                                <button
                                                    key={r}
                                                    type={"button"}
                                                    title={r}
                                                    aria-label={`effort: ${r}`}
                                                    aria-pressed={active}
                                                    onClick={() => chooseEffort(r)}
                                                    className={
                                                        "relative flex h-6 flex-1 cursor-pointer " +
                                                        "items-center justify-center"
                                                    }
                                                >
                                                    <span
                                                        aria-hidden
                                                        className={
                                                            "rounded-full transition-all " +
                                                            (active
                                                                ? "h-4 w-3 bg-foreground/80"
                                                                : "h-1.5 w-1.5 bg-foreground/30")
                                                        }
                                                    />
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                )}

                {/* working directory — same row as the model and effort chips,
                    pushed to the far right so it sits under the send button.
                    `ml-auto` is what does that; nothing else in the row grows. */}
                <button
                    type={"button"}
                    onClick={() => void pickCwd()}
                    disabled={!sessionId}
                    title={cwdError || `${cwd || "…"} — click to choose a folder`}
                    aria-label={`Working directory: ${cwd || "loading"}. Click to choose a folder.`}
                    className={
                        "ml-auto flex min-w-0 cursor-pointer items-center gap-1.5 py-1 px-1 " +
                        "font-mono text-xs transition-colors hover:text-foreground " +
                        "disabled:cursor-default disabled:opacity-40 " +
                        (cwdError ? "text-red-400" : "text-gray-400")
                    }
                >
                    <Folder aria-hidden className={"h-3 w-3 shrink-0"} />
                    <span className={"truncate"}>{cwd ? shortPath(cwd) : "…"}</span>
                </button>
            </div>

            {/* the branch in that directory, subordinate to the chip above it —
                a line the eye skips until it needs it. Absent entirely outside a
                repository rather than shown empty: there is nothing to say. */}
            {branch && (
                <div
                    className={
                        "-mt-1 flex min-w-0 items-center justify-end gap-1.5 px-1 " +
                        "font-mono text-[10px] text-gray-400"
                    }
                >
                    <CodeBranch aria-hidden className={"h-2.5 w-2.5 shrink-0"} />
                    <span className={"truncate"}>{branch}</span>
                </div>
            )}
        </form>
    );
}
