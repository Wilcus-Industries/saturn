"use client";

import { useRef, useState } from "react";
import { FaArrowUp, FaChevronDown } from "react-icons/fa6";

// visual-only for now — the selector feeds nothing yet, wiring comes later
const MODELS = [
    { slug: "anthropic/claude-sonnet-4.5", label: "claude sonnet 4.5" },
    { slug: "anthropic/claude-opus-4.1", label: "claude opus 4.1" },
    { slug: "openai/gpt-5", label: "gpt-5" },
    { slug: "google/gemini-2.5-pro", label: "gemini 2.5 pro" },
    { slug: "x-ai/grok-4", label: "grok 4" },
];

// visual-only composer — submit clears the box, model wiring comes later
export default function AgentComposer() {
    const [value, setValue] = useState("");
    const [model, setModel] = useState(MODELS[0].slug);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

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
            <div className={"flex items-center"}>
                <label className={"group relative inline-flex cursor-pointer items-center"}>
                    <span className={"sr-only"}>Model</span>
                    <select
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        className={
                            "cursor-pointer appearance-none bg-transparent py-1 pr-5 pl-1 " +
                            // sizes to the selected label where supported; fallback = widest option
                            "[field-sizing:content] " +
                            "font-mono text-xs text-gray-400 outline-none transition-colors " +
                            "group-hover:text-foreground focus-visible:text-foreground"
                        }
                    >
                        {MODELS.map((m) => (
                            <option key={m.slug} value={m.slug} className={"bg-background text-foreground"}>
                                {m.label}
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
            </div>
        </form>
    );
}
