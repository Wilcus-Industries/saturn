"use client";

import { useEffect, useState } from "react";
import ActionButton from "@/app/dashboard/actionButton";
import EmojiGrid from "@/app/dashboard/emojiGrid";
import type { RegistryEntryRow } from "@/lib/registry";
import { saveSkill } from "./actions";

// add ("+ add skill") or edit ("edit") trigger + modal for one skill
export default function SkillModal({ entry }: { entry?: RegistryEntryRow }) {
    const [open, setOpen] = useState(false);

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
                    onClick={() => setOpen(true)}
                    className={"font-mono text-sm text-blue-400"}
                >
                    edit
                </button>
            ) : (
                <button
                    type={"button"}
                    onClick={() => setOpen(true)}
                    className={`self-start border border-dashed border-foreground/30 px-3 py-1.5
                        font-mono text-sm text-gray-400 transition-colors duration-200
                        hover:border-foreground hover:text-foreground`}
                >
                    + add skill
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
                                await saveSkill(formData);
                                setOpen(false);
                            }}
                            className={"flex flex-col gap-4"}
                        >
                            <h2 className={"font-mono text-xl"}>
                                {entry ? "edit skill" : "new skill"}
                            </h2>

                            {entry && <input type={"hidden"} name={"id"} value={entry.id} />}

                            <label className={"flex flex-col gap-1"}>
                                <span className={"font-mono text-xs text-gray-400"}>name</span>
                                <input
                                    name={"name"}
                                    required
                                    autoFocus
                                    defaultValue={entry?.name}
                                    className={"border border-foreground/15 bg-background p-2 font-mono text-sm"}
                                />
                            </label>

                            <div className={"flex flex-col gap-1"}>
                                <span className={"font-mono text-xs text-gray-400"}>emoji</span>
                                <EmojiGrid initial={entry?.emoji || undefined} />
                            </div>

                            <label className={"flex flex-col gap-1"}>
                                <span className={"font-mono text-xs text-gray-400"}>
                                    instructions
                                </span>
                                <textarea
                                    name={"description"}
                                    rows={3}
                                    defaultValue={entry?.description}
                                    className={"border border-foreground/15 bg-background p-2 font-mono text-sm"}
                                />
                            </label>

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
