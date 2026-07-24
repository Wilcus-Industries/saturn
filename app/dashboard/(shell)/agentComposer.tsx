"use client";

import { useMemo, useRef, useState } from "react";
import { FaArrowUp, FaChevronDown } from "react-icons/fa6";
import ModelLogo from "@/app/dashboard/workflows/[id]/modelLogo";
import type { OpenrouterModel } from "@/lib/openrouter.server";

// shown when the OpenRouter fetch degraded to [] — the selector still renders
const FALLBACK_MODELS: OpenrouterModel[] = [
    { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", outputModalities: ["text"], supportsReasoning: true },
    { id: "anthropic/claude-opus-4.1", name: "Claude Opus 4.1", outputModalities: ["text"], supportsReasoning: true },
    { id: "openai/gpt-5", name: "GPT-5", outputModalities: ["text"], supportsReasoning: true },
    { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", outputModalities: ["text"], supportsReasoning: true },
];

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";
const MAX_LISTED = 120;

// mirrors the agent node's reasoning select (executeAgentTurn allowlist)
const REASONING_LEVELS = ["off", "low", "medium", "high"] as const;

// visual-only composer — submit clears the box, model wiring comes later
export default function AgentComposer({ models }: { models: OpenrouterModel[] }) {
    const [value, setValue] = useState("");
    const [model, setModel] = useState(DEFAULT_MODEL);
    const [reasoning, setReasoning] = useState("medium");
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState("");
    const textareaRef = useRef<HTMLTextAreaElement>(null);

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
        if (empty) return;
        setValue("");
        const el = textareaRef.current;
        if (el) el.style.height = "auto";
    }

    function pick(id: string) {
        setModel(id);
        setOpen(false);
        setQ("");
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
                    <FaArrowUp />
                </button>
            </div>

            <div className={"relative flex items-center"}>
                <button
                    type={"button"}
                    aria-haspopup={"listbox"}
                    aria-expanded={open}
                    title={model}
                    onClick={() => setOpen((o) => !o)}
                    className={
                        "group flex cursor-pointer items-center gap-1.5 py-1 px-1 font-mono " +
                        "text-xs text-gray-400 transition-colors hover:text-foreground " +
                        (open ? "text-foreground" : "")
                    }
                >
                    <span>{selected?.name ?? model}</span>
                    <span className={"shrink-0 overflow-hidden rounded-full"}>
                        <ModelLogo slug={model} name={selected?.name ?? model} size={16} />
                    </span>
                    <FaChevronDown
                        aria-hidden
                        className={`h-2.5 w-2.5 transition-transform ${open ? "rotate-180" : ""}`}
                    />
                </button>

                {open && (
                    <>
                        {/* backdrop closes on any outside click */}
                        <div className={"fixed inset-0 z-10"} onClick={() => setOpen(false)} />
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
                    <label className={"group relative ml-3 inline-flex cursor-pointer items-center"}>
                        <span className={"sr-only"}>Reasoning effort</span>
                        <select
                            value={reasoning}
                            onChange={(e) => setReasoning(e.target.value)}
                            className={
                                "cursor-pointer appearance-none bg-transparent py-1 pr-5 pl-1 " +
                                // sizes to the selected label where supported; fallback = widest option
                                "[field-sizing:content] " +
                                "font-mono text-xs text-gray-400 outline-none transition-colors " +
                                "group-hover:text-foreground focus-visible:text-foreground"
                            }
                        >
                            {REASONING_LEVELS.map((r) => (
                                <option key={r} value={r} className={"bg-background text-foreground"}>
                                    reasoning: {r}
                                </option>
                            ))}
                        </select>
                        <FaChevronDown
                            aria-hidden
                            className={
                                "pointer-events-none absolute right-1 h-2.5 w-2.5 text-gray-400 " +
                                "transition-colors group-hover:text-foreground"
                            }
                        />
                    </label>
                )}
            </div>
        </form>
    );
}
