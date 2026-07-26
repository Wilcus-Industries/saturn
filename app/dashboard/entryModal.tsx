"use client";

import { useState } from "react";
import EmojiGrid from "@/app/dashboard/emojiGrid";
import Field from "@/app/dashboard/field";
import ModalShell from "@/app/dashboard/modalShell";
import { call } from "@/lib/ipc";
import type { RegistryEntryRow } from "@/lib/registry";

// a skill and a memory store are the same registry entry with different wording:
// a name, an emoji and one block of prose. Everything that differs lives here.
const KINDS: Record<
    "skill" | "memory",
    {
        noun: string;
        cmd: string;
        emoji?: string; // EmojiGrid's own default when absent
        prose: string;
        placeholder?: string;
        hint?: string;
        failed: string;
    }
> = {
    skill: {
        noun: "skill",
        cmd: "save_skill",
        prose: "instructions",
        failed: "Save failed",
    },
    memory: {
        noun: "memory store",
        cmd: "save_memory_store",
        emoji: "🧠",
        prose: "note",
        placeholder: "What should the agent remember here?",
        hint: "the agent sees this note as guidance for what belongs in the store",
        failed: "Something went wrong",
    },
};

// add ("+ add skill") or edit ("edit") trigger + modal for one entry
export default function EntryModal({
    kind,
    entry,
    onSaved,
}: {
    kind: keyof typeof KINDS;
    entry?: RegistryEntryRow;
    onSaved: () => void;
}) {
    const spec = KINDS[kind];

    // controlled — React resets uncontrolled fields after a form action, which
    // would wipe the user's input when the action returns an error
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");

    return (
        <ModalShell
            title={`${entry ? "edit" : "new"} ${spec.noun}`}
            submitLabel={entry ? "save →" : "add →"}
            action={async (formData) => {
                try {
                    await call(spec.cmd, {
                        id: entry?.id ?? null,
                        name: String(formData.get("name") ?? ""),
                        emoji: String(formData.get("emoji") ?? ""),
                        description: String(formData.get("description") ?? ""),
                    });
                } catch (err) {
                    return { error: err instanceof Error ? err.message : spec.failed };
                }
                onSaved();
            }}
            onOpen={() => {
                setName(entry?.name ?? "");
                setDescription(entry?.description ?? "");
            }}
            trigger={(open) =>
                entry ? (
                    <button
                        type={"button"}
                        onClick={open}
                        className={"font-mono text-sm text-blue-400"}
                    >
                        edit
                    </button>
                ) : (
                    <button
                        type={"button"}
                        onClick={open}
                        className={`self-start border border-dashed border-foreground/30 px-3 py-1.5
                            font-mono text-sm text-gray-400 transition-colors duration-200
                            hover:border-foreground hover:text-foreground`}
                    >
                        + add {spec.noun}
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
                <EmojiGrid initial={entry?.emoji || spec.emoji} />
            </div>

            <label className={"flex flex-col gap-1"}>
                <span className={"font-mono text-xs text-gray-400"}>{spec.prose}</span>
                <textarea
                    name={"description"}
                    rows={3}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={spec.placeholder}
                    className={"border border-foreground/15 bg-background p-2 font-mono text-sm"}
                />
                {spec.hint && (
                    <span className={"font-mono text-xs text-gray-400"}>{spec.hint}</span>
                )}
            </label>
        </ModalShell>
    );
}
