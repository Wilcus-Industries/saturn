import Link from "next/link";
import { relativeTime, STATUS_DOT } from "./workflows/workflowCard";

export type RecentRun = {
    id: string;
    trigger: "cron" | "manual";
    status: "running" | "success" | "error";
    started_at: Date;
    workflow_id: string;
    workflow_name: string;
    workflow_emoji: string;
};

export default function RecentRuns({ runs, now }: { runs: RecentRun[]; now: Date }) {
    return (
        <section className={"flex w-full flex-col gap-4 border border-foreground/15 p-4"}>
            <h2 className={"font-mono text-xl"}>Recent runs</h2>
            {runs.length === 0 ? (
                <p className={"font-mono text-sm text-gray-400"}>
                    no runs yet — activate a workflow or hit run in the designer
                </p>
            ) : (
                <div className={"flex flex-col gap-2"}>
                    {runs.map((run) => (
                        <Link
                            key={run.id}
                            href={`/dashboard/workflows/${run.workflow_id}/runs`}
                            className={`flex items-center gap-3 border border-foreground/15 p-3
                                transition-colors duration-200 hover:border-foreground/40`}
                        >
                            <span
                                aria-hidden
                                className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[run.status]}`}
                            />
                            <span>{run.workflow_emoji}</span>
                            <span className={"truncate font-mono text-sm"}>{run.workflow_name}</span>
                            <span className={"ml-auto font-mono text-xs whitespace-nowrap text-gray-400"}>
                                {run.trigger} ·{" "}
                                {run.status === "running"
                                    ? "running"
                                    : relativeTime(run.started_at, now)}
                            </span>
                        </Link>
                    ))}
                </div>
            )}
        </section>
    );
}
