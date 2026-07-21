"use client";

import { useEffect, useState } from "react";
import ActionButton from "@/app/dashboard/actionButton";
import type { RegistryEntryRow } from "@/lib/registry";
import { saveSandbox } from "./actions";

// add ("+ add sandbox") or edit ("edit") trigger + modal for one sandbox
export default function SandboxModal({ entry }: { entry?: RegistryEntryRow }) {
    const [open, setOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // controlled — React resets uncontrolled fields after a form action, which
    // would wipe the user's input when the action returns an error
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");

    const openModal = () => {
        setError(null);
        setName(entry?.name ?? "");
        setDescription(entry?.description ?? "");
        setOpen(true);
    };

    // Escape closes; listener only lives while the modal is open
    useEffect(() => {
        if (!open) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [open]);

    return (
        <>
            {entry ? (
                <button
                    type={"button"}
                    onClick={openModal}
                    className={"font-mono text-sm text-blue-400"}
                >
                    edit
                </button>
            ) : (
                <button
                    type={"button"}
                    onClick={openModal}
                    className={`self-start border border-dashed border-foreground/30 px-3 py-1.5
                        font-mono text-sm text-gray-400 transition-colors duration-200
                        hover:border-foreground hover:text-foreground`}
                >
                    + add sandbox
                </button>
            )}

            {open && (
                <div
                    className={"fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"}
                    onClick={() => setOpen(false)}
                >
                    {/* clicks inside the panel must not reach the backdrop */}
                    <div
                        className={"w-full max-w-md border border-foreground/15 bg-background p-6"}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <form
                            action={async (formData) => {
                                setError(null);
                                const result = await saveSandbox(formData);
                                if (result) {
                                    setError(result.error);
                                    return;
                                }
                                setOpen(false);
                            }}
                            className={"flex flex-col gap-4"}
                        >
                            <h2 className={"font-mono text-xl"}>
                                {entry ? "edit sandbox" : "add sandbox"}
                            </h2>

                            {entry && <input type={"hidden"} name={"id"} value={entry.id} />}

                            <label className={"flex flex-col gap-1"}>
                                <span className={"font-mono text-xs text-gray-400"}>name</span>
                                <input
                                    name={"name"}
                                    required
                                    autoFocus
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    className={"border border-foreground/15 bg-background p-2 font-mono text-sm"}
                                />
                            </label>

                            <label className={"flex flex-col gap-1"}>
                                <span className={"font-mono text-xs text-gray-400"}>
                                    description
                                </span>
                                <textarea
                                    name={"description"}
                                    rows={3}
                                    value={description}
                                    onChange={(e) => setDescription(e.target.value)}
                                    placeholder={"what this environment is for — shown to the agent"}
                                    className={"border border-foreground/15 bg-background p-2 font-mono text-sm"}
                                />
                            </label>

                            {error && (
                                <p className={"font-mono text-xs text-red-400"}>{error}</p>
                            )}

                            <ActionButton
                                className={`self-end rounded-full border border-foreground px-4 py-2
                                    font-mono text-sm transition-colors duration-200
                                    hover:bg-foreground hover:text-background`}
                            >
                                {entry ? "save →" : "add →"}
                            </ActionButton>
                        </form>
                    </div>
                </div>
            )}
        </>
    );
}
