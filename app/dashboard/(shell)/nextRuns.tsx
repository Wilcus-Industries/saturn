// Presentational list of upcoming scheduled runs. Countdowns are computed from
// the raw cron; the runner clamps cadence to the tier cron floor at claim time,
// so for a downgraded user this can read optimistically — accepted.

import Link from "next/link";
import { describeCron } from "@/lib/cron";

export type ScheduledWorkflow = {
    id: string;
    name: string;
    emoji: string;
    cron: string;
    next: Date | null; // null = no occurrence within the scan cap
};

// "in 3m" / "in 2h" / "in 5d" ladder — mirrors relativeTime in workflowCard.tsx
function countdown(next: Date | null, now: Date): string {
    if (next === null) return "—";
    const minutes = Math.max(0, Math.ceil((next.getTime() - now.getTime()) / 60_000));
    if (minutes === 0) return "now";
    if (minutes < 60) return `in ${minutes}m`;
    if (minutes < 1440) return `in ${Math.floor(minutes / 60)}h`;
    return `in ${Math.floor(minutes / 1440)}d`;
}

export default function NextRuns({ workflows, now }: { workflows: ScheduledWorkflow[]; now: Date }) {
    return (
        <section className={"flex w-full flex-col gap-4 border border-foreground/15 p-4"}>
            <h2 className={"font-mono text-xl"}>Next scheduled</h2>
            {workflows.length === 0 ? (
                <p className={"font-mono text-sm text-gray-400"}>
                    no active workflows — activate one to schedule runs
                </p>
            ) : (
                <div className={"flex flex-col gap-2"}>
                    {workflows.map((w) => (
                        <Link
                            key={w.id}
                            href={`/dashboard/workflows/${w.id}`}
                            className={`flex items-center gap-3 border border-foreground/15 p-3
                                transition-colors duration-200 hover:border-foreground/40`}
                        >
                            <span>{w.emoji}</span>
                            <span className={"truncate font-mono text-sm"}>{w.name}</span>
                            <span
                                className={`rounded-full border border-foreground/15 px-3 py-1
                                    font-mono text-xs text-gray-400 whitespace-nowrap`}
                            >
                                {describeCron(w.cron)}
                            </span>
                            <span className={"ml-auto font-mono text-xs text-gray-400 whitespace-nowrap"}>
                                {countdown(w.next, now)}
                            </span>
                        </Link>
                    ))}
                </div>
            )}
        </section>
    );
}
