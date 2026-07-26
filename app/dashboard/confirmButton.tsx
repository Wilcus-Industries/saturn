"use client";

import { useEffect, useState } from "react";

// two-step inline confirm: first click arms, second calls `onConfirm`; disarms
// after 3s. Shared by every delete in the shell and the designer.
//
// The caller owns what confirming does and what happens afterwards, because no
// two want the same thing: the settings page reports a failure at the top of the
// page (this button has no error slot), the list card refetches in place, and
// the designer topbar navigates out of a workflow that no longer exists.
export default function ConfirmButton({
    onConfirm,
    // text size — most callers keep the text-sm default, the designer topbar
    // passes text-xs to match its control cluster
    sizeClass = "text-sm",
}: {
    onConfirm: () => void | Promise<void>;
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
            onClick={() => void onConfirm()}
            className={`border border-red-500 px-2 font-mono ${sizeClass} transition-colors
                duration-200 hover:bg-red-600 hover:text-white`}
        >
            confirm?
        </button>
    );
}
