"use client";

import { useState } from "react";
import Field from "@/app/dashboard/field";
import ModalShell from "@/app/dashboard/modalShell";
import { call } from "@/lib/ipc";
import type { RegistryEntryRow } from "@/lib/registry";
import ToolListEditor from "./toolListEditor";

// Saturn's own tools, pinned above the mcp servers in the same card chrome —
// minus everything that needs a server (no host, no token, no connect) and
// minus delete: the row is seeded, so the only edits are the per-tool access
// switches and the workspace run_command gets to work in.
export default function BuiltinToolsCard({
    entry,
    onSaved,
}: {
    entry: RegistryEntryRow;
    onSaved: () => void;
}) {
    // controlled, like every other modal field — a failed save must not wipe it
    const [workspace, setWorkspace] = useState("");
    const enabledTools = entry.tools.filter((t) => t.enabled).length;

    return (
        <div className={"flex flex-col border border-foreground/15"}>
            <div className={"flex items-center gap-3 p-3"}>
                <span className={"text-2xl"}>{entry.emoji}</span>
                <div className={"flex min-w-0 flex-col"}>
                    <span className={"truncate font-mono text-sm"}>{entry.name}</span>
                    <span className={"truncate font-mono text-xs text-gray-400"}>built in</span>
                </div>
            </div>
            <div
                className={`flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-foreground/15
                    px-3 py-2 font-mono text-xs text-gray-400`}
            >
                <span>
                    {enabledTools}/{entry.tools.length} tools
                </span>
                <div className={"ml-auto flex shrink-0 items-center gap-3"}>
                    <ModalShell
                        wide
                        title={"saturn tools"}
                        submitLabel={"save →"}
                        action={async (formData: FormData) => {
                            try {
                                await call("saturn_save_tools", {
                                    tools: String(formData.get("tools") ?? "[]"),
                                    workspace: String(formData.get("workspace") ?? ""),
                                });
                            } catch (err) {
                                return {
                                    error: err instanceof Error ? err.message : "Save failed",
                                };
                            }
                            onSaved();
                        }}
                        onOpen={() => setWorkspace(entry.workspace)}
                        trigger={(open) => (
                            <button
                                type={"button"}
                                onClick={open}
                                className={"font-mono text-sm text-blue-400"}
                            >
                                edit
                            </button>
                        )}
                    >
                        <Field
                            label={"workspace"}
                            name={"workspace"}
                            placeholder={"~/Saturn"}
                            value={workspace}
                            onChange={(e) => setWorkspace(e.target.value)}
                        />

                        <p className={"font-mono text-xs text-gray-400"}>
                            run_command runs bash in this directory, and it is the only place
                            Saturn may write
                        </p>

                        <ToolListEditor initial={entry.tools} fixed />
                    </ModalShell>
                </div>
            </div>
        </div>
    );
}
