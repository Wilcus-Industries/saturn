"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback } from "react";
import { LINE_STYLES } from "@/app/dashboard/workflows/designer/console";
import { call, ErrorNote, Loading, useAsync } from "@/lib/ipc";
import type { ConsoleLine } from "@/lib/interpreter";
import { relativeTime } from "../workflowCard";

// run history for one workflow; lives inside (shell) so it gets the sidebar,
// unlike the shell-less designer at /dashboard/workflows/designer.
type RunRow = {
    id: string;
    trigger: "cron" | "manual" | "event";
    status: "running" | "success" | "error";
    error: string;
    log: ConsoleLine[];
    started_at: number;
    finished_at: number | null;
};

const STATUS_STYLES: Record<RunRow["status"], { dot: string; text: string }> = {
    success: { dot: "bg-green-500", text: "text-green-600 dark:text-green-400" },
    error: { dot: "bg-red-500", text: "text-red-600 dark:text-red-400" },
    running: {
        dot: "bg-gray-400 animate-pulse motion-reduce:animate-none",
        text: "text-gray-400",
    },
};

// runs execute on a UTC schedule, so times render as UTC
function utcTime(ms: number): string {
    return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function duration(start: number, end: number): string {
    const seconds = Math.max(0, Math.round((end - start) / 1000));
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function WorkflowRuns() {
    // the [id] segment is gone — static export can't enumerate dynamic routes
    const id = useSearchParams().get("id") ?? "";

    const load = useCallback(
        () =>
            Promise.all([
                // only for the heading; the extra read is fine on a cold page
                call<{ name: string; emoji: string }>("get_workflow", { id }),
                call<RunRow[]>("list_runs", { workflowId: id }),
            ]),
        [id],
    );
    const { data, error, loading, reload } = useAsync(load);
    const [workflow, runs] = data ?? [];

    return (
        <div className={"flex flex-col gap-6"}>
            <div className={"flex flex-wrap items-baseline gap-x-3 gap-y-1"}>
                <h1 className={"font-mono text-3xl"}>
                    {workflow ? (
                        `${workflow.emoji} ${workflow.name}`
                    ) : (
                        // hold the line box so the page doesn't jump when it lands
                        <span aria-hidden>&nbsp;</span>
                    )}
                </h1>
                <span className={"font-mono text-sm text-gray-400"}>runs</span>
                <Link
                    href={`/dashboard/workflows/designer/?id=${id}`}
                    className={`font-mono text-sm text-gray-400 underline underline-offset-4
                        transition-colors duration-200 hover:text-foreground`}
                >
                    open designer →
                </Link>
            </div>

            {loading && <Loading what={"loading runs"} />}
            {error && <ErrorNote error={error} retry={reload} />}
            {runs?.length === 0 && (
                <p className={"font-mono text-sm text-gray-400"}>
                    no runs yet — scheduled runs and their logs will show up here
                </p>
            )}

            <div className={"flex flex-col gap-3"}>
                {runs?.map((run) => (
                    <div
                        key={run.id}
                        className={"flex flex-col gap-2 border border-foreground/15 p-4"}
                    >
                        <div className={"flex flex-wrap items-center gap-3 font-mono text-xs"}>
                            <span
                                className={`inline-flex items-center gap-1.5 rounded-full border
                                    border-foreground/15 px-3 py-1
                                    ${STATUS_STYLES[run.status].text}`}
                            >
                                <span
                                    aria-hidden
                                    className={`h-1.5 w-1.5 rounded-full
                                        ${STATUS_STYLES[run.status].dot}`}
                                />
                                {run.status}
                            </span>
                            <span
                                className={`rounded-full border border-foreground/15 px-3 py-1
                                    text-gray-400`}
                            >
                                {run.trigger}
                            </span>
                            <span className={"text-gray-400"}>
                                {utcTime(run.started_at)} ({relativeTime(run.started_at)})
                            </span>
                            {run.finished_at && (
                                <span className={"text-gray-400"}>
                                    took {duration(run.started_at, run.finished_at)}
                                </span>
                            )}
                        </div>

                        {run.status === "error" && run.error && (
                            <p
                                className={
                                    "font-mono text-xs break-words whitespace-pre-wrap text-red-500"
                                }
                            >
                                {run.error}
                            </p>
                        )}

                        <details>
                            <summary
                                className={`cursor-pointer font-mono text-xs text-gray-400
                                    transition-colors duration-200 hover:text-foreground`}
                            >
                                log ({run.log.length} {run.log.length === 1 ? "line" : "lines"})
                            </summary>
                            <div
                                className={
                                    "mt-2 border-t border-foreground/15 pt-2 font-mono text-xs"
                                }
                            >
                                {run.log.length === 0 && (
                                    <div className={"text-gray-400"}>(no output)</div>
                                )}
                                {run.log.map((line, i) => (
                                    <div
                                        key={i}
                                        className={`break-words whitespace-pre-wrap
                                            ${LINE_STYLES[line.kind]}`}
                                    >
                                        {line.text}
                                    </div>
                                ))}
                            </div>
                        </details>
                    </div>
                ))}
            </div>
        </div>
    );
}

// useSearchParams needs a Suspense boundary above it under static export
export default function WorkflowRunsPage() {
    return (
        <Suspense fallback={<Loading what={"loading runs"} />}>
            <WorkflowRuns />
        </Suspense>
    );
}
