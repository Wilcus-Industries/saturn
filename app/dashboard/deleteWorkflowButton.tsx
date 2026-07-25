"use client";

import { useEffect, useState } from "react";
import { call } from "@/lib/ipc";

// two-step inline confirm: first click arms, second deletes; disarms after 3s.
//
// `onDeleted` is required rather than defaulted because its two callers want
// genuinely different things and neither is the obvious default: the list card
// refetches in place, the designer topbar navigates back out of a workflow that
// no longer exists. The server action used to redirect for both, which only
// worked because a redirect happens to do both jobs at once.
export default function DeleteWorkflowButton({
    id,
    onDeleted,
    sizeClass = "text-sm",
}: {
    id: string;
    onDeleted: () => void;
    // text size — list cards keep the text-sm default, the designer topbar
    // passes text-xs to match its control cluster
    sizeClass?: string;
}) {
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
                className={`font-mono ${sizeClass} text-gray-400 hover:text-red-500`}
            >
                delete
            </button>
        );
    }

    return (
        <button
            type={"button"}
            // delete_workflow is idempotent, so a double-fire is harmless and
            // there is nothing to report on failure the user could act on
            onClick={() => void call("delete_workflow", { id }).then(onDeleted, onDeleted)}
            className={`border border-red-500 px-2 font-mono ${sizeClass} transition-colors
                duration-200 hover:bg-red-600 hover:text-white`}
        >
            confirm?
        </button>
    );
}
