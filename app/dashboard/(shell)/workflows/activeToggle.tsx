"use client";

import { useState } from "react";
import { call } from "@/lib/ipc";

// pill switch for scheduled execution; manual/test runs work regardless.
// z-10 keeps it clickable above the card's stretched link.
//
// The pill owns its state instead of rendering optimistically over the prop:
// the list's refetch lands a beat after the write resolves, so deferring back to
// the prop in between would snap the pill to its old position for that beat.
// Nothing else on the card reads `active`, so there is nothing to refetch for.
export default function ActiveToggle({ id, active }: { id: string; active: boolean }) {
    const [on, setOn] = useState(active);

    return (
        <button
            type={"button"}
            role={"switch"}
            aria-checked={on}
            aria-label={on ? "Turn workflow off" : "Turn workflow on"}
            onClick={() => {
                // explicit desired state, not a flip, so a double-click is idempotent
                const next = !on;
                setOn(next);
                // reverting is the only report available — there is no toast here
                void call("set_workflow_active", { id, active: next }).catch(() => setOn(!next));
            }}
            className={`relative z-10 inline-flex h-5 w-9 shrink-0 items-center rounded-full
                border px-0.5 transition-colors duration-200
                ${
                    on
                        ? "border-green-500 dark:border-green-400"
                        : "border-foreground/15 hover:border-foreground/40"
                }`}
        >
            <span
                aria-hidden
                className={`h-3 w-3 rounded-full transition-transform duration-200
                    motion-reduce:transition-none
                    ${on ? "translate-x-4 bg-green-500 dark:bg-green-400" : "translate-x-0 bg-gray-400"}`}
            />
        </button>
    );
}
