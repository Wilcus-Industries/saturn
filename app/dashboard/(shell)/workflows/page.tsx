"use client";

import { call, ErrorNote, Loading, useAsync } from "@/lib/ipc";
import WorkflowCard, { type CardRow } from "./workflowCard";
import WorkflowModal from "./workflowModal";

// module-level so it's stable — useAsync takes `load` as its dependency
const load = () => call<CardRow[]>("list_workflows");

// scheduled agentic workflows
export default function Workflows() {
    const { data, error, loading, reload } = useAsync(load);

    return (
        <div className={"flex flex-col gap-6"}>
            <h1 className={"font-mono text-3xl"}>Workflows</h1>

            {loading && <Loading what={"loading workflows"} />}
            {error && <ErrorNote error={error} retry={reload} />}
            {data?.length === 0 && (
                <p className={"font-mono text-sm text-gray-400"}>
                    no workflows yet — create one to get started
                </p>
            )}

            {/* the "+" card renders immediately: creating doesn't need the list */}
            <div className={"grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"}>
                {data?.map((workflow) => (
                    <WorkflowCard key={workflow.id} workflow={workflow} onChanged={reload} />
                ))}
                <WorkflowModal onSaved={reload} />
            </div>
        </div>
    );
}
