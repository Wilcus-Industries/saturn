"use client";

import { useEffect, useState } from "react";
import { wipeMemoryStore } from "../actions";

// two-step armed wipe for every item in a store; disarms after 3s. Kept out of
// the shared ConfirmButton: this one is the page's primary control, with its
// own padding and hover transition.
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
