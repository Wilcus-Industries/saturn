"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_MODEL } from "@/lib/agent";
import { ArrowUp, ChevronDown, Stop } from "@/app/dashboard/icons";
import ModelLogo from "@/app/dashboard/workflows/designer/modelLogo";
// type-only import — compile-erased, safe in a client component
import type { OpenrouterModel } from "@/app/dashboard/workflows/designer/designer";

// shown when the OpenRouter fetch degraded to [] — the selector still renders
const FALLBACK_MODELS: OpenrouterModel[] = [
    { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", outputModalities: ["text"], supportsReasoning: true },
    { id: "anthropic/claude-opus-4.1", name: "Claude Opus 4.1", outputModalities: ["text"], supportsReasoning: true },
    { id: "openai/gpt-5", name: "GPT-5", outputModalities: ["text"], supportsReasoning: true },
    { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", outputModalities: ["text"], supportsReasoning: true },
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

// composer for the Agent chat — owns the model + reasoning selectors and hands
// the message text up via onSend; the parent (agentChat.tsx) owns the transcript
export default function AgentComposer({
    models,
    onSend,
    streaming,
    onStop,
}: {
    models: OpenrouterModel[];
    onSend: (text: string, model: string, reasoning: string) => void;
    streaming: boolean;
    onStop: () => void;
}) {
    const [value, setValue] = useState("");
    const [model, setModel] = useState(DEFAULT_MODEL);
    const [reasoning, setReasoning] = useState<string>(DEFAULT_EFFORT);
    const [open, setOpen] = useState(false);
    const [effortOpen, setEffortOpen] = useState(false);
    const [q, setQ] = useState("");
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const pickersRef = useRef<HTMLDivElement>(null);

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

    const all = models.length > 0 ? models : FALLBACK_MODELS;
    const selected = all.find((m) => m.id === model);

    const listed = useMemo(() => {
        const needle = q.trim().toLowerCase();
        const hits = needle
            ? all.filter(
                  (m) => m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle),
              )
            : all;
        return { rows: hits.slice(0, MAX_LISTED), more: Math.max(0, hits.length - MAX_LISTED) };
    }, [all, q]);

    const empty = value.trim() === "";

    function resize() {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
    }

    function submit() {
        if (empty || streaming) return;
        onSend(value.trim(), model, reasoning);
        setValue("");
        const el = textareaRef.current;
        if (el) el.style.height = "auto";
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
                    onChange={(e) => setValue(e.target.value)}
                    onInput={resize}
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
                                {listed.rows.map((m) => (
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
                                        <span className={"min-w-0 flex-1 truncate"}>{m.name}</span>
                                        <span className={"shrink-0 overflow-hidden rounded-full"}>
                                            <ModelLogo slug={m.id} name={m.name} size={16} />
                                        </span>
                                    </button>
                                ))}
                                {listed.rows.length === 0 && (
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
            </div>
        </form>
    );
}
