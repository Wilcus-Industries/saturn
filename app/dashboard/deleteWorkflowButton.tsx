"use client";

import { useEffect, useState } from "react";
import { deleteWorkflow } from "@/app/dashboard/(shell)/workflows/actions";

// two-step inline confirm: first click arms, second submits; disarms after 3s
export default function DeleteWorkflowButton({
    id,
    sizeClass = "text-sm",
}: {
    id: string;
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
        <form action={deleteWorkflow}>
            <input type={"hidden"} name={"id"} value={id} />
            <button
                type={"submit"}
                className={`border border-red-500 px-2 font-mono ${sizeClass} transition-colors
                    duration-200 hover:bg-red-600 hover:text-white`}
            >
                confirm?
            </button>
        </form>
    );
}
