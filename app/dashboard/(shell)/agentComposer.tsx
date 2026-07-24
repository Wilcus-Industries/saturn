"use client";

import { useRef, useState } from "react";
import { FaArrowUp } from "react-icons/fa6";

// visual-only composer — submit clears the box, model wiring comes later
export default function AgentComposer() {
    const [value, setValue] = useState("");
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
            <p className={"text-center font-mono text-xs text-gray-400"}>
                Saturn Agent is warming up — replies coming soon.
            </p>
        </form>
    );
}
