"use client";

import { useEffect, useState } from "react";
import ActionButton from "@/app/dashboard/actionButton";
import EmojiGrid from "@/app/dashboard/emojiGrid";
import type { WorkflowRow } from "@/lib/workflow";
import { createWorkflow, updateWorkflow } from "./actions";
import CronBuilder from "./cronBuilder";

type WorkflowMeta = Pick<WorkflowRow, "id" | "name" | "emoji" | "description" | "cron">;

// create (dashed hollow "+" card) or edit ("edit" on a card) trigger + modal
// for one workflow's metadata; the graph is edited in the designer
export default function WorkflowModal({ workflow }: { workflow?: WorkflowMeta }) {
    const [open, setOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // controlled — React resets uncontrolled fields after a form action, which
    // would wipe the user's input when the action returns an error
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");

    const openModal = () => {
        setError(null);
        setName(workflow?.name ?? "");
        setDescription(workflow?.description ?? "");
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
            {workflow ? (
                <button
                    type={"button"}
                    onClick={openModal}
                    className={"font-mono text-sm text-gray-400 hover:text-foreground"}
                >
                    edit
                </button>
            ) : (
                <button
                    type={"button"}
                    onClick={openModal}
                    aria-label={"new workflow"}
                    className={`flex min-h-40 items-center justify-center rounded-xl border border-dashed
                        border-foreground/30 text-3xl text-gray-400 transition-colors duration-200
                        hover:border-foreground hover:text-foreground`}
                >
                    +
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
                                const result = workflow
                                    ? await updateWorkflow(formData)
                                    : await createWorkflow(formData);
                                if (result) {
                                    setError(result.error);
                                    return;
                                }
                                // create never gets here — its action redirects
                                setOpen(false);
                            }}
                            className={"flex flex-col gap-4"}
                        >
                            <h2 className={"font-mono text-xl"}>
                                {workflow ? "edit workflow" : "new workflow"}
                            </h2>

                            {workflow && <input type={"hidden"} name={"id"} value={workflow.id} />}

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

                            <div className={"flex flex-col gap-1"}>
                                <span className={"font-mono text-xs text-gray-400"}>emoji</span>
                                <EmojiGrid initial={workflow?.emoji || undefined} />
                            </div>

                            <label className={"flex flex-col gap-1"}>
                                <span className={"font-mono text-xs text-gray-400"}>description</span>
                                <textarea
                                    name={"description"}
                                    rows={2}
                                    value={description}
                                    onChange={(e) => setDescription(e.target.value)}
                                    className={"border border-foreground/15 bg-background p-2 font-mono text-sm"}
                                />
                            </label>

                            <div className={"flex flex-col gap-1"}>
                                <span className={"font-mono text-xs text-gray-400"}>schedule</span>
                                <CronBuilder initial={workflow?.cron} />
                            </div>

                            {error && (
                                <p className={"font-mono text-xs text-red-400"}>{error}</p>
                            )}

                            <ActionButton
                                className={`self-end rounded-full border border-foreground px-4 py-2
                                    font-mono text-sm transition-colors duration-200
                                    hover:bg-foreground hover:text-background`}
                            >
                                {workflow ? "save →" : "create →"}
                            </ActionButton>
                        </form>
                    </div>
                </div>
            )}
        </>
    );
}
