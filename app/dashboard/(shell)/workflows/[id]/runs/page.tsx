import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getSessionCached } from "@/lib/subscription";
import { relativeTime } from "../../workflowCard";

// run history for one workflow; lives inside (shell) so it gets the sidebar,
// unlike the shell-less designer at /dashboard/workflows/[id]. session check
// lives here, not the layout.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RunRow = {
    id: string;
    trigger: "cron" | "manual" | "event";
    status: "running" | "success" | "error";
    error: string;
    log: { kind: string; text: string }[];
    started_at: Date;
    finished_at: Date | null;
};

// duplicated from app/dashboard/workflows/[id]/console.tsx — its LINE_STYLES
// lives in a "use client" module, which a server component can't import from
const LINE_STYLES: Record<string, string> = {
    print: "text-foreground",
    info: "text-gray-400",
    warn: "text-yellow-600 dark:text-yellow-400",
    error: "text-red-500",
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
function utcTime(d: Date): string {
    return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function duration(start: Date, end: Date): string {
    const seconds = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export default async function WorkflowRuns({
    params,
}: PageProps<"/dashboard/workflows/[id]/runs">) {
    const { id } = await params;
    // pre-validate before querying — junk ids would throw pg 22P02, not miss
    if (!UUID.test(id)) notFound();

    const session = await getSessionCached();
    if (!session?.user) redirect("/onboard");

    // ownership check — runs are only reachable through the user's workflow
    const { rows: workflows } = await db.query<{ name: string; emoji: string }>(
        "select name, emoji from workflow where id = $1 and user_id = $2",
        [id, session.user.id],
    );
    if (!workflows[0]) notFound();
    const workflow = workflows[0];

    const { rows: runs } = await db.query<RunRow>(
        `select id, trigger, status, error, log, started_at, finished_at
         from workflow_run where workflow_id = $1
         order by started_at desc limit 50`,
        [id],
    );

    return (
        <div className={"flex flex-col gap-6"}>
            <div className={"flex flex-wrap items-baseline gap-x-3 gap-y-1"}>
                <h1 className={"font-mono text-3xl"}>
                    {workflow.emoji} {workflow.name}
                </h1>
                <span className={"font-mono text-sm text-gray-400"}>runs</span>
                <Link
                    href={`/dashboard/workflows/${id}`}
                    className={`font-mono text-sm text-gray-400 underline underline-offset-4
                        transition-colors duration-200 hover:text-foreground`}
                >
                    open designer →
                </Link>
            </div>

            {runs.length === 0 && (
                <p className={"font-mono text-sm text-gray-400"}>
                    no runs yet — scheduled runs and their logs will show up here
                </p>
            )}

            <div className={"flex flex-col gap-3"}>
                {runs.map((run) => {
                    const log = Array.isArray(run.log) ? run.log : [];
                    return (
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
                                    log ({log.length} {log.length === 1 ? "line" : "lines"})
                                </summary>
                                <div
                                    className={
                                        "mt-2 border-t border-foreground/15 pt-2 font-mono text-xs"
                                    }
                                >
                                    {log.length === 0 && (
                                        <div className={"text-gray-400"}>(no output)</div>
                                    )}
                                    {log.map((line, i) => (
                                        <div
                                            key={i}
                                            className={`break-words whitespace-pre-wrap
                                                ${LINE_STYLES[line.kind] ?? "text-foreground"}`}
                                        >
                                            {line.text}
                                        </div>
                                    ))}
                                </div>
                            </details>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
