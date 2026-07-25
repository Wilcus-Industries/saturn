"use client";

import Link from "next/link";
import DeleteWorkflowButton from "@/app/dashboard/deleteWorkflowButton";
import ActiveToggle from "./activeToggle";
import LinkSpinner from "./linkSpinner";
import WorkflowModal from "./workflowModal";

// exactly what `list_workflows` returns — the old LEFT JOIN LATERAL for the
// newest run now happens in Rust, so the card no longer assembles a `lastRun`
export type CardRow = {
    id: string;
    name: string;
    emoji: string;
    description: string;
    active: boolean;
    last_run_status: "running" | "success" | "error" | null;
    last_run_started_at: number | null;
};

// "3m ago" style; every timestamp crossing IPC is epoch ms, not a Date
// (also used by the runs page and the memory store page)
export function relativeTime(from: number, to = Date.now()): string {
    const seconds = Math.max(0, Math.floor((to - from) / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

const STATUS_DOT: Record<NonNullable<CardRow["last_run_status"]>, string> = {
    success: "bg-green-500",
    error: "bg-red-500",
    running: "bg-gray-400 animate-pulse motion-reduce:animate-none",
};

export default function WorkflowCard({
    workflow,
    onChanged,
}: {
    workflow: CardRow;
    // the list owns the data now — an edit or a delete has to tell it to refetch
    onChanged: () => void;
}) {
    return (
        <div
            className={`group relative flex min-h-40 flex-col gap-2 border border-foreground/15
                p-4 transition-colors duration-200 hover:border-foreground/40`}
        >
            {/* stretched link keeps the whole card clickable without nesting the delete button in an anchor */}
            <Link
                href={`/dashboard/workflows/designer/?id=${workflow.id}`}
                aria-label={`Open ${workflow.name}`}
                className={"absolute inset-0"}
            >
                <LinkSpinner className={"absolute right-3 bottom-3 font-mono text-gray-400"} />
            </Link>
            <span className={"text-4xl"}>{workflow.emoji}</span>
            <span className={"font-mono"}>{workflow.name}</span>
            {workflow.description && (
                <p className={"text-sm text-gray-400 line-clamp-2"}>{workflow.description}</p>
            )}
            <div className={"flex flex-wrap items-center gap-2"}>
                {/* z-10 keeps the chip clickable above the card's stretched link */}
                <Link
                    href={`/dashboard/workflows/runs/?id=${workflow.id}`}
                    className={`relative z-10 inline-flex items-center gap-1.5 rounded-full border
                        border-foreground/15 px-3 py-1 font-mono text-xs text-gray-400
                        transition-colors duration-200 hover:border-foreground/40
                        hover:text-foreground`}
                >
                    {workflow.last_run_status && workflow.last_run_started_at ? (
                        <>
                            <span
                                aria-hidden
                                className={`h-1.5 w-1.5 rounded-full
                                    ${STATUS_DOT[workflow.last_run_status]}`}
                            />
                            {workflow.last_run_status === "running"
                                ? "running"
                                : relativeTime(workflow.last_run_started_at)}
                        </>
                    ) : (
                        "never run"
                    )}
                </Link>
                <ActiveToggle id={workflow.id} active={workflow.active} />
            </div>
            <div
                className={`absolute top-3 right-3 z-10 flex items-center gap-3 opacity-0
                    transition-opacity duration-200 focus-within:opacity-100
                    group-hover:opacity-100 max-sm:opacity-100`}
            >
                <WorkflowModal workflow={workflow} onSaved={onChanged} />
                <DeleteWorkflowButton id={workflow.id} onDeleted={onChanged} />
            </div>
        </div>
    );
}
