"use client";

import { useActionState, useEffect, useState } from "react";
import { unlinkGithubInstallation } from "./actions";

// two-step inline confirm (mirrors DeleteEntryButton): first click arms, second
// submits; disarms after 3s. Unlinks a GitHub App installation row. Uses
// useActionState so the action's { error } result surfaces inline instead of
// hitting Next's generic error page.
export default function UnlinkInstallationButton({ installationId }: { installationId: number }) {
    const [armed, setArmed] = useState(false);
    const [state, action] = useActionState<{ error?: string }, FormData>(
        async (_prev, formData) => (await unlinkGithubInstallation(formData)) ?? {},
        {},
    );

    useEffect(() => {
        if (!armed) return;
        const timer = setTimeout(() => setArmed(false), 3000);
        return () => clearTimeout(timer);
    }, [armed]);

    if (!armed) {
        return (
            <div className={"flex items-center gap-2"}>
                {state.error && (
                    <span className={"font-mono text-xs text-red-400"}>{state.error}</span>
                )}
                <button
                    type={"button"}
                    onClick={() => setArmed(true)}
                    className={"font-mono text-sm text-gray-400 hover:text-red-500"}
                >
                    unlink
                </button>
            </div>
        );
    }

    return (
        <form action={action}>
            <input type={"hidden"} name={"installationId"} value={installationId} />
            <button
                type={"submit"}
                onClick={() => setArmed(false)}
                className={`border border-red-500 px-2 font-mono text-sm transition-colors
                    duration-200 hover:bg-red-600 hover:text-white`}
            >
                confirm?
            </button>
        </form>
    );
}
