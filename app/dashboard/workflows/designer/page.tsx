"use client";

import { Suspense, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { call, ErrorNote, Loading, useAsync } from "@/lib/ipc";
import type { SessionRow } from "@/app/dashboard/(shell)/agent/sessionPicker";
import { buildUserCatalog, type RegistryEntryRow, sessionEntry, UUID_RE } from "@/lib/registry";
import type { WorkflowGraph } from "@/lib/workflow";
import Designer, { type OpenrouterModel } from "./designer";

// the fields of the workflow row the designer actually reads — the rest of what
// get_workflow returns (timestamps, active) belongs to the list page
type Workflow = { id: string; name: string; emoji: string; graph: WorkflowGraph };

// lives outside the (shell) route group on purpose — the designer takes over the
// full screen without the dashboard sidebar. The id rides the query string: a
// static export can't enumerate a dynamic segment.
function DesignerPage() {
    const id = useSearchParams().get("id") ?? "";

    const load = useCallback(async () => {
        // pre-validate so a junk id fails here with a readable message rather
        // than as a bare "Invalid workflow id" from three commands at once
        if (!UUID_RE.test(id)) throw new Error("no such workflow");
        // user-registered mcp servers/skills/memory/variables join the static
        // catalog as nodes; everything the page needs rides one fan-out
        const [workflow, registry, sessions, openrouterModels, githubLinked] = await Promise.all([
            call<Workflow>("get_workflow", { id }),
            call<RegistryEntryRow[]>("list_registry"),
            // chats are not registry rows but they are catalog entries — the
            // chip that grants an agent a persistent conversation
            call<SessionRow[]>("saturn_list_sessions"),
            // null = no OpenRouter key (toolbox hints at settings); [] = unlocked
            // but the fetch failed
            call<OpenrouterModel[] | null>("list_openrouter_models"),
            call<boolean>("has_github_pat"),
        ]);
        return { workflow, registry, sessions, openrouterModels, githubLinked };
    }, [id]);

    // live:false — a background cron run firing `data-changed` would hand the
    // designer a fresh userCatalog array mid-edit, breaking every memoized
    // Node's props for nothing. Registry edits here refetch explicitly (reload).
    const { data, error, loading, reload } = useAsync(load, { live: false });

    if (loading || error || !data) {
        return (
            <div className={"flex h-dvh items-center justify-center"}>
                {loading ? (
                    <Loading what={"loading designer"} />
                ) : (
                    <ErrorNote error={error ?? "no such workflow"} retry={reload} />
                )}
            </div>
        );
    }

    const { workflow, registry, sessions, openrouterModels, githubLinked } = data;
    // variables for the toolbox split — name + secret flag + whether a value is
    // set. For secrets the value never reaches the client (value is '' from the
    // guarded projection); regular variables carry their viewable plaintext.
    const variables = registry
        .filter((r) => r.kind === "variable")
        .map((r) => ({
            id: r.id,
            name: r.name,
            secret: r.secret,
            hasValue: r.has_token,
            value: r.value,
        }));

    return (
        <Designer
            // the graph seeds a reducer at mount, so switching workflows without
            // leaving the route has to remount rather than re-render
            key={workflow.id}
            workflow={workflow}
            userCatalog={[
                ...buildUserCatalog(registry),
                ...sessions.map((s) => sessionEntry(s.id, s.name)),
            ]}
            variables={variables}
            openrouterModels={openrouterModels}
            githubLinked={githubLinked}
            onRegistryChange={reload}
        />
    );
}

// useSearchParams needs a Suspense boundary to prerender under output: "export"
export default function WorkflowDesigner() {
    return (
        <Suspense
            fallback={
                <div className={"flex h-dvh items-center justify-center"}>
                    <Loading what={"loading designer"} />
                </div>
            }
        >
            <DesignerPage />
        </Suspense>
    );
}
