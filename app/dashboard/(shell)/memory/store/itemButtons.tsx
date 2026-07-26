"use client";

import { useEffect, useState } from "react";
import { call } from "@/lib/ipc";

// two-step armed delete for a single memory item; disarms after 3s
export function DeleteItemButton({ id, onDeleted }: { id: string; onDeleted: () => void }) {
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
        <button
            type={"button"}
            // refetch either way: the only failure is "Not found", and a row that
            // is already gone is exactly what the refetch will show
            onClick={() => void call("delete_memory_item", { id }).then(onDeleted, onDeleted)}
            className={`shrink-0 border border-red-500 px-2 font-mono text-xs transition-colors
                duration-200 hover:bg-red-600 hover:text-white`}
        >
            confirm?
        </button>
    );
}

// two-step armed wipe for every item in a store; disarms after 3s
export function WipeStoreButton({ id, onWiped }: { id: string; onWiped: () => void }) {
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
        <button
            type={"button"}
            onClick={() => void call("wipe_memory_store", { entryId: id }).then(onWiped, onWiped)}
            className={`border border-red-500 px-3 py-1 font-mono text-sm transition-colors
                duration-200 hover:bg-red-600 hover:text-white`}
        >
            confirm wipe?
        </button>
    );
}
