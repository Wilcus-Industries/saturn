"use client";

import { useState } from "react";
import EmojiGrid from "@/app/dashboard/emojiGrid";
import ModalShell from "@/app/dashboard/modalShell";
import type { WorkflowRow } from "@/lib/workflow";
import { createWorkflow, updateWorkflow } from "./actions";

type WorkflowMeta = Pick<WorkflowRow, "id" | "name" | "emoji" | "description">;

// create (dashed hollow "+" card) or edit ("edit" on a card) trigger + modal
// for one workflow's metadata; the graph is edited in the designer
export default function WorkflowModal({ workflow }: { workflow?: WorkflowMeta }) {
    // controlled — React resets uncontrolled fields after a form action, which
    // would wipe the user's input when the action returns an error
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");

    return (
        <ModalShell
            title={workflow ? "edit workflow" : "new workflow"}
            submitLabel={workflow ? "save →" : "create →"}
            action={workflow ? updateWorkflow : createWorkflow}
            entryId={workflow?.id}
            onOpen={() => {
                setName(workflow?.name ?? "");
                setDescription(workflow?.description ?? "");
            }}
            trigger={(open) =>
                workflow ? (
                    <button
                        type={"button"}
                        onClick={open}
                        className={"font-mono text-sm text-gray-400 hover:text-foreground"}
                    >
                        edit
                    </button>
                ) : (
                    <button
                        type={"button"}
                        onClick={open}
                        aria-label={"new workflow"}
                        className={`flex min-h-40 items-center justify-center rounded-xl border border-dashed
                            border-foreground/30 text-3xl text-gray-400 transition-colors duration-200
                            hover:border-foreground hover:text-foreground`}
                    >
                        +
                    </button>
                )
            }
        >
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
        </ModalShell>
    );
}
