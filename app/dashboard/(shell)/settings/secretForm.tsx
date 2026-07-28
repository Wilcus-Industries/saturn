"use client";

import { useState } from "react";
import ActionButton from "@/app/dashboard/actionButton";
import Field from "@/app/dashboard/field";
import { call } from "@/lib/ipc";

// the Keychain-backed secrets on this page are the same form every time: a
// password field, a clear checkbox that only exists once something is stored,
// and a save. Write-only both ways — the value never comes back over IPC, so
// blank means "keep" and there is nothing to prefill.
export default function SecretForm({
    field,
    placeholder,
    isSet,
    cmd,
    onSaved,
}: {
    field: string;
    placeholder: string;
    isSet: boolean;
    cmd: string;
    onSaved: () => void;
}) {
    const [error, setError] = useState<string | null>(null);

    return (
        <form
            className={"flex flex-col gap-3"}
            action={async (formData: FormData) => {
                setError(null);
                try {
                    // Rust writes the value verbatim, so the trim happens here —
                    // an accidental space must read as "keep", not overwrite
                    await call(cmd, {
                        value: String(formData.get("value") ?? "").trim(),
                        clear: formData.get("clear") === "on",
                    });
                } catch (err) {
                    setError(err instanceof Error ? err.message : "Save failed");
                    return;
                }
                onSaved();
            }}
        >
            {/* uncontrolled on purpose — write-only, so there is nothing to prefill */}
            <Field
                label={field}
                name={"value"}
                type={"password"}
                autoComplete={"off"}
                placeholder={isSet ? "•••• set — leave blank to keep" : placeholder}
            />

            {error && <p className={"font-mono text-xs text-red-400"}>{error}</p>}

            <div className={"flex items-center gap-4"}>
                {isSet && (
                    <label className={"flex items-center gap-2 font-mono text-xs text-gray-400"}>
                        <input type={"checkbox"} name={"clear"} />
                        clear stored value
                    </label>
                )}
                <ActionButton
                    className={`ml-auto rounded-full border border-foreground px-4 py-2
                        font-mono text-sm transition-colors duration-200
                        hover:bg-foreground hover:text-background`}
                >
                    save →
                </ActionButton>
            </div>
        </form>
    );
}
