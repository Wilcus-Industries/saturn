"use client";

import { useState } from "react";
import EmojiGrid from "@/app/dashboard/emojiGrid";
import ModalShell from "@/app/dashboard/modalShell";
import type { RegistryEntryRow } from "@/lib/registry";
import { saveMemoryStore } from "./actions";

// add ("+ add memory store") or edit ("edit") trigger + modal for one store
export default function MemoryModal({ entry }: { entry?: RegistryEntryRow }) {
    // controlled — React resets uncontrolled fields after a form action, which
    // would wipe the user's input when the action returns an error
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");

    return (
        <ModalShell
            title={entry ? "edit memory store" : "new memory store"}
            submitLabel={entry ? "save →" : "add →"}
            action={saveMemoryStore}
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
                        + add memory store
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
                <EmojiGrid initial={entry?.emoji || "🧠"} />
            </div>

            <label className={"flex flex-col gap-1"}>
                <span className={"font-mono text-xs text-gray-400"}>note</span>
                <textarea
                    name={"description"}
                    rows={3}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={"What should the agent remember here?"}
                    className={"border border-foreground/15 bg-background p-2 font-mono text-sm"}
                />
                <span className={"font-mono text-xs text-gray-400"}>
                    the agent sees this note as guidance for what belongs in the store
                </span>
            </label>
        </ModalShell>
    );
}
