"use client";

import { useEffect, useState } from "react";
import { deleteMemoryItem, wipeMemoryStore } from "../actions";

// two-step armed delete for a single memory item; disarms after 3s
export function DeleteItemButton({ id, entryId }: { id: string; entryId: string }) {
    const [armed, setArmed] = useState(false);

    useEffect(() => {
        if (!armed) return;
        const timer = setTimeout(() => setArmed(false), 3000);
        return () => clearTimeout(timer);
    }, [armed]);

    if (!armed) {
        return (
            <button
                type={"button"}
                onClick={() => setArmed(true)}
                className={"shrink-0 font-mono text-xs text-gray-400 hover:text-red-500"}
            >
                forget
            </button>
        );
    }

    return (
        <form action={deleteMemoryItem}>
            <input type={"hidden"} name={"id"} value={id} />
            <input type={"hidden"} name={"entryId"} value={entryId} />
            <button
                type={"submit"}
                className={`shrink-0 border border-red-500 px-2 font-mono text-xs transition-colors
                    duration-200 hover:bg-red-600 hover:text-white`}
            >
                confirm?
            </button>
        </form>
    );
}

// two-step armed wipe for every item in a store; disarms after 3s
export function WipeStoreButton({ id }: { id: string }) {
    const [armed, setArmed] = useState(false);

    useEffect(() => {
        if (!armed) return;
        const timer = setTimeout(() => setArmed(false), 3000);
        return () => clearTimeout(timer);
    }, [armed]);

    if (!armed) {
        return (
            <button
                type={"button"}
                onClick={() => setArmed(true)}
                className={`font-mono text-sm text-gray-400 transition-colors duration-200
                    hover:text-red-500`}
            >
                wipe all
            </button>
        );
    }

    return (
        <form action={wipeMemoryStore}>
            <input type={"hidden"} name={"id"} value={id} />
            <button
                type={"submit"}
                className={`border border-red-500 px-3 py-1 font-mono text-sm transition-colors
                    duration-200 hover:bg-red-600 hover:text-white`}
            >
                confirm wipe?
            </button>
        </form>
    );
}
