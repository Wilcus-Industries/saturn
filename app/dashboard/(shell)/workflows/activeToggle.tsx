"use client";

import { useOptimistic, useTransition } from "react";
import { setWorkflowActive } from "./actions";

// pill switch for scheduled execution; manual/test runs work regardless.
// z-10 keeps it clickable above the card's stretched link.
export default function ActiveToggle({ id, active }: { id: string; active: boolean }) {
    const [, startTransition] = useTransition();
    const [optimistic, setOptimistic] = useOptimistic(active);

    return (
        <button
            type={"button"}
            role={"switch"}
            aria-checked={optimistic}
            aria-label={optimistic ? "Turn workflow off" : "Turn workflow on"}
            onClick={() =>
                startTransition(async () => {
                    setOptimistic(!optimistic);
                    await setWorkflowActive(id, !optimistic);
                })
            }
            className={`relative z-10 inline-flex h-5 w-9 shrink-0 items-center rounded-full
                border px-0.5 transition-colors duration-200
                ${
                    optimistic
                        ? "border-green-500 dark:border-green-400"
                        : "border-foreground/15 hover:border-foreground/40"
                }`}
        >
            <span
                aria-hidden
                className={`h-3 w-3 rounded-full transition-transform duration-200
                    motion-reduce:transition-none
                    ${
                        optimistic
                            ? "translate-x-4 bg-green-500 dark:bg-green-400"
                            : "translate-x-0 bg-gray-400"
                    }`}
            />
        </button>
    );
}
