"use client";

import { useState } from "react";
import EmojiGrid from "@/app/dashboard/emojiGrid";
import ModalShell from "@/app/dashboard/modalShell";
import type { RegistryEntryRow } from "@/lib/registry";
import { saveSkill } from "./actions";

// add ("+ add skill") or edit ("edit") trigger + modal for one skill
export default function SkillModal({ entry }: { entry?: RegistryEntryRow }) {
    // controlled — React resets uncontrolled fields after a form action, which
    // would wipe the user's input when the action returns an error
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");

    return (
        <ModalShell
            title={entry ? "edit skill" : "new skill"}
            submitLabel={entry ? "save →" : "add →"}
            action={saveSkill}
            entryId={entry?.id}
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
                        + add skill
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
                <EmojiGrid initial={entry?.emoji || undefined} />
            </div>

            <label className={"flex flex-col gap-1"}>
                <span className={"font-mono text-xs text-gray-400"}>instructions</span>
                <textarea
                    name={"description"}
                    rows={3}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className={"border border-foreground/15 bg-background p-2 font-mono text-sm"}
                />
            </label>
        </ModalShell>
    );
}
