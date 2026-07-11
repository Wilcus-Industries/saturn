"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import DeleteWorkflowButton from "@/app/dashboard/deleteWorkflowButton";
import { describeCron } from "@/lib/cron";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export default function Topbar({
    workflowId,
    emoji,
    name,
    cron,
    dirty,
    saving,
    error,
    onRun,
    onStop,
    running,
}: {
    workflowId: string;
    emoji: string;
    name: string;
    cron: string;
    dirty: boolean;
    saving: boolean;
    error: string | null;
    onRun: () => void;
    onStop: () => void;
    running: boolean;
}) {
    const [frame, setFrame] = useState(0);

    useEffect(() => {
        if (!saving) return;
        const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
        return () => clearInterval(id);
    }, [saving]);

    return (
        <header
            className={
                "flex h-12 shrink-0 items-center gap-3 border-b border-foreground/15 px-3 font-mono text-sm"
            }
        >
            <Link
                href={"/dashboard/workflows"}
                className={
                    "rounded-full px-3 py-1 text-gray-400 transition-colors duration-200 hover:bg-foreground hover:text-background"
                }
            >
                ← workflows
            </Link>

            <span className={"truncate"}>
                {emoji} {name}
            </span>

            {/* schedule is edited from the list page's edit modal */}
            <span
                className={
                    "hidden shrink-0 rounded-full border border-foreground/15 px-3 py-0.5 text-xs text-gray-400 sm:inline"
                }
            >
                {describeCron(cron)}
            </span>

            {/* run history lives on a shell page, not in the designer */}
            <Link
                href={`/dashboard/workflows/${workflowId}/runs`}
                className={`hidden shrink-0 rounded-full border border-foreground/15 px-3 py-0.5
                    text-xs text-gray-400 transition-colors duration-200
                    hover:border-foreground/40 hover:text-foreground sm:inline`}
            >
                runs
            </Link>

            <span className={"ml-auto flex items-center gap-3"}>
                {/* test run — see interpreter.ts; turns into a stop button
                    while running (an in-flight MCP call finishes, then the
                    run halts before the next step) */}
                {running ? (
                    <button
                        type={"button"}
                        onClick={onStop}
                        className={`border border-red-500 px-2 py-0.5 text-red-600 transition-colors
                            duration-200 hover:bg-red-600 hover:text-white dark:text-red-400`}
                    >
                        ■ stop
                    </button>
                ) : (
                    <button
                        type={"button"}
                        onClick={onRun}
                        className={`border border-green-500 px-2 py-0.5 text-green-600 transition-colors
                            duration-200 hover:bg-green-600 hover:text-white dark:text-green-400`}
                    >
                        ▶ run
                    </button>
                )}
                <DeleteWorkflowButton id={workflowId} />
            </span>

            {/* autosave status — one slot, always rendered, so the layout doesn't shift */}
            <span className={"text-xs"} aria-live={"polite"} aria-busy={saving}>
                {saving ? (
                    <span className={"text-gray-400"}>{FRAMES[frame]}</span>
                ) : error ? (
                    <span className={"text-red-500"}>save failed — retrying</span>
                ) : dirty ? (
                    <span className={"text-gray-400"} title={"unsaved changes"}>
                        ●
                    </span>
                ) : (
                    <span className={"text-gray-400"}>saved</span>
                )}
            </span>
        </header>
    );
}
