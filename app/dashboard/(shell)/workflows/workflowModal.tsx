"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import EmojiGrid from "@/app/dashboard/emojiGrid";
import Field from "@/app/dashboard/field";
import ModalShell from "@/app/dashboard/modalShell";
import { call } from "@/lib/ipc";
import type { CardRow } from "./workflowCard";

type WorkflowMeta = Pick<CardRow, "id" | "name" | "emoji" | "description">;

// create (dashed hollow "+" card) or edit ("edit" on a card) trigger + modal
// for one workflow's metadata; the graph is edited in the designer
export default function WorkflowModal({
    workflow,
    onSaved,
}: {
    workflow?: WorkflowMeta;
    onSaved: () => void;
}) {
    const router = useRouter();
    // controlled — React resets uncontrolled fields after a form action, which
    // would wipe the user's input when the action returns an error
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");

    // name/emoji/description are validated in Rust; blank emoji becomes ⚙️ there
    const save = async (formData: FormData) => {
        const fields = {
            name: String(formData.get("name") ?? "").trim(),
            emoji: String(formData.get("emoji") ?? "").trim(),
            description: String(formData.get("description") ?? "").trim(),
        };
        try {
            if (workflow) {
                await call("update_workflow", { id: workflow.id, ...fields });
            } else {
                // create used to redirect from the server action; now the command
                // hands back the row and the modal navigates itself
                const created = await call<{ id: string }>("create_workflow", fields);
                router.push(`/dashboard/workflows/designer/?id=${created.id}`);
                return;
            }
        } catch (err) {
            return { error: err instanceof Error ? err.message : "Something went wrong" };
        }
        onSaved();
    };

    return (
        <ModalShell
            title={workflow ? "edit workflow" : "new workflow"}
            submitLabel={workflow ? "save →" : "create →"}
            action={save}
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
            <Field
                label={"name"}
                name={"name"}
                required
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
            />

            <div className={"flex flex-col gap-1"}>
                <span className={"font-mono text-xs text-gray-400"}>emoji</span>
                <EmojiGrid initial={workflow?.emoji || undefined} />
            </div>

            <Field
                label={"description"}
                name={"description"}
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
            />
        </ModalShell>
    );
}
