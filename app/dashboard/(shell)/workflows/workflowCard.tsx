import Link from "next/link";
import DeleteWorkflowButton from "@/app/dashboard/deleteWorkflowButton";
import type { WorkflowRow } from "@/lib/workflow";
import ActiveToggle from "./activeToggle";
import WorkflowModal from "./workflowModal";

export type LastRun = {
    status: "running" | "success" | "error";
    startedAt: Date;
};

// "3m ago" style; computed at server render time (also used by the runs page)
export function relativeTime(from: Date, to = new Date()): string {
    const seconds = Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

export const STATUS_DOT: Record<LastRun["status"], string> = {
    success: "bg-green-500",
    error: "bg-red-500",
    running: "bg-gray-400 animate-pulse motion-reduce:animate-none",
};

export default function WorkflowCard({
    workflow,
    lastRun,
}: {
    workflow: Pick<WorkflowRow, "id" | "name" | "emoji" | "description" | "active">;
    lastRun: LastRun | null;
}) {
    return (
        <div
            className={`group relative flex min-h-40 flex-col gap-2 border border-foreground/15
                p-4 transition-colors duration-200 hover:border-foreground/40`}
        >
            {/* stretched link keeps the whole card clickable without nesting the delete button in an anchor */}
            <Link
                href={`/dashboard/workflows/${workflow.id}`}
                aria-label={`Open ${workflow.name}`}
                className={"absolute inset-0"}
            />
            <span className={"text-4xl"}>{workflow.emoji}</span>
            <span className={"font-mono"}>{workflow.name}</span>
            {workflow.description && (
                <p className={"text-sm text-gray-400 line-clamp-2"}>{workflow.description}</p>
            )}
            <div className={"flex flex-wrap items-center gap-2"}>
                {/* z-10 keeps the chip clickable above the card's stretched link */}
                <Link
                    href={`/dashboard/workflows/${workflow.id}/runs`}
                    className={`relative z-10 inline-flex items-center gap-1.5 rounded-full border
                        border-foreground/15 px-3 py-1 font-mono text-xs text-gray-400
                        transition-colors duration-200 hover:border-foreground/40
                        hover:text-foreground`}
                >
                    {lastRun ? (
                        <>
                            <span
                                aria-hidden
                                className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[lastRun.status]}`}
                            />
                            {lastRun.status === "running"
                                ? "running"
                                : relativeTime(lastRun.startedAt)}
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
                <WorkflowModal workflow={workflow} />
                <DeleteWorkflowButton id={workflow.id} />
            </div>
        </div>
    );
}
