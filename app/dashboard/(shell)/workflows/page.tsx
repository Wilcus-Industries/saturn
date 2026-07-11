import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import type { WorkflowRow } from "@/lib/workflow";
import WorkflowCard from "./workflowCard";
import WorkflowModal from "./workflowModal";

// scheduled agentic workflows; session check lives here, not the layout
export default async function Workflows() {
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });
    if (!session?.user) redirect("/onboard");

    // lateral join pulls each workflow's newest run for the card status chip
    const { rows } = await db.query<
        Pick<WorkflowRow, "id" | "name" | "emoji" | "description" | "cron"> & {
            last_run_status: "running" | "success" | "error" | null;
            last_run_started_at: Date | null;
        }
    >(
        `select w.id, w.name, w.emoji, w.description, w.cron,
                r.status as last_run_status, r.started_at as last_run_started_at
         from workflow w
         left join lateral (
             select status, started_at from workflow_run
             where workflow_id = w.id
             order by started_at desc
             limit 1
         ) r on true
         where w.user_id = $1
         order by w.created_at desc`,
        [session.user.id],
    );

    return (
        <div className={"flex flex-col gap-6"}>
            <h1 className={"font-mono text-3xl"}>Workflows</h1>

            {rows.length === 0 && (
                <p className={"font-mono text-sm text-gray-400"}>
                    no workflows yet — create one to get started
                </p>
            )}

            <div className={"grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"}>
                {rows.map((workflow) => (
                    <WorkflowCard
                        key={workflow.id}
                        workflow={workflow}
                        lastRun={
                            workflow.last_run_status && workflow.last_run_started_at
                                ? {
                                      status: workflow.last_run_status,
                                      startedAt: workflow.last_run_started_at,
                                  }
                                : null
                        }
                    />
                ))}
                <WorkflowModal />
            </div>
        </div>
    );
}
