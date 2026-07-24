"use client";

import { useActionState, useEffect, useState } from "react";

// two-step inline confirm shared by every destructive dashboard button: first
// click arms, second submits; disarms after 3s
export default function ConfirmButton({
    action,
    fields,
    label = "delete",
    title,
    sizeClass = "text-sm",
    extraClass = "",
    inlineError = false,
}: {
    // server action the confirm form posts to
    action: (formData: FormData) => Promise<{ error?: string } | void>;
    // hidden inputs carrying the row id(s) the action needs
    fields: Record<string, string | number>;
    label?: string;
    title?: string;
    // text size — list cards keep the text-sm default, the designer topbar and
    // memory item rows pass text-xs to match their control clusters
    sizeClass?: string;
    // classes both states share (memory item rows need shrink-0)
    extraClass?: string;
    // route the submit through useActionState so the action's { error } result
    // surfaces inline instead of hitting Next's generic error page
    inlineError?: boolean;
}) {
    const [armed, setArmed] = useState(false);
    const [state, wrapped] = useActionState<{ error?: string }, FormData>(
        async (_prev, formData) => (await action(formData)) ?? {},
        {},
    );

    useEffect(() => {
        if (!armed) return;
        const timer = setTimeout(() => setArmed(false), 3000);
        return () => clearTimeout(timer);
    }, [armed]);

    if (!armed) {
        const idle = (
            <button
                type={"button"}
                onClick={() => setArmed(true)}
                className={`font-mono ${sizeClass} text-gray-400 hover:text-red-500 ${extraClass}`.trimEnd()}
            >
                {label}
            </button>
        );
        if (!inlineError) return idle;
        return (
            <div className={"flex items-center gap-2"}>
                {state.error && (
                    <span className={"font-mono text-xs text-red-400"}>{state.error}</span>
                )}
                {idle}
            </div>
        );
    }

    return (
        // the raw action stays a server reference for the void-returning cases,
        // so their native form post (and server-side redirect) is untouched
        <form action={inlineError ? wrapped : (action as (f: FormData) => Promise<void>)}>
            {Object.entries(fields).map(([name, value]) => (
                <input key={name} type={"hidden"} name={name} value={value} />
            ))}
            <button
                type={"submit"}
                title={title}
                // no navigation follows an inline-error submit, so disarm by hand
                onClick={inlineError ? () => setArmed(false) : undefined}
                className={`border border-red-500 px-2 font-mono ${sizeClass}
                    transition-colors duration-200 hover:bg-red-600 hover:text-white ${extraClass}`.trimEnd()}
            >
                {"confirm?"}
            </button>
        </form>
    );
}
