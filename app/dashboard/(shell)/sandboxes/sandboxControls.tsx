"use client";

import { useEffect, useState } from "react";
import { resetSandboxAction, stopSandboxAction } from "./actions";

// stop (when running) + two-step reset controls for one sandbox; reset returns
// an error value which we surface inline
export default function SandboxControls({ id, running }: { id: string; running: boolean }) {
    const [armed, setArmed] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!armed) return;
        const timer = setTimeout(() => setArmed(false), 3000);
        return () => clearTimeout(timer);
    }, [armed]);

    return (
        <div className={"flex flex-col items-end gap-1"}>
            <div className={"flex items-center gap-3"}>
                {running && (
                    <form action={stopSandboxAction}>
                        <input type={"hidden"} name={"id"} value={id} />
                        <button
                            type={"submit"}
                            className={"font-mono text-sm text-gray-400 hover:text-foreground"}
                        >
                            stop
                        </button>
                    </form>
                )}

                {!armed ? (
                    <button
                        type={"button"}
                        onClick={() => {
                            setError(null);
                            setArmed(true);
                        }}
                        className={"font-mono text-sm text-gray-400 hover:text-red-500"}
                    >
                        reset
                    </button>
                ) : (
                    <form
                        action={async (formData) => {
                            setError(null);
                            const result = await resetSandboxAction(formData);
                            setArmed(false);
                            if (result) setError(result.error);
                        }}
                    >
                        <input type={"hidden"} name={"id"} value={id} />
                        <button
                            type={"submit"}
                            title={"wipes all files in /work"}
                            className={`border border-red-500 px-2 font-mono text-sm transition-colors
                                duration-200 hover:bg-red-600 hover:text-white`}
                        >
                            wipe all files?
                        </button>
                    </form>
                )}
            </div>

            {error && <p className={"font-mono text-xs text-red-400"}>{error}</p>}
        </div>
    );
}
