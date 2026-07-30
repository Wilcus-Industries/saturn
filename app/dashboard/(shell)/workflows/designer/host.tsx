"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { SessionRow } from "@/app/dashboard/(shell)/agent/sessionPicker";
import { call, ErrorNote, Loading, useAsync } from "@/lib/ipc";
import { buildUserCatalog, type RegistryEntryRow, sessionEntry, UUID_RE } from "@/lib/registry";
import type { WorkflowGraph } from "@/lib/workflow";
import Designer, { type ProviderModels } from "./designer";
import { getOpen, serverOpen, subscribe } from "./openStore";

// the fields of the workflow row the designer actually reads — the rest of what
// get_workflow returns (timestamps, active) belongs to the list page
type Workflow = { id: string; name: string; emoji: string; graph: WorkflowGraph };

/// The designer's real mount point, rendered by `(shell)/layout.tsx` and NOT by
/// the designer's route — which is what keeps it alive across a nav tab switch
/// (`openStore.ts` has the argument). It reads the open workflow from module
/// state rather than `?id=`, because the query string is gone the moment the
/// user is looking at another tab.
///
/// `hidden` is CSS, never an unmount, and it is also `active`'s inverse: a
/// display:none designer must not answer the keyboard, so the flag is threaded
/// down to every `window` listener it owns.
export default function DesignerHost({ hidden }: { hidden: boolean }) {
    const { id, nonce } = useSyncExternalStore(subscribe, getOpen, serverOpen);

    const load = useCallback(async () => {
        // pre-validate so a junk id fails here with a readable message rather
        // than as a bare "Invalid workflow id" from three commands at once
        if (!UUID_RE.test(id)) throw new Error("no such workflow");
        // user-registered mcp servers/skills/memory/variables join the static
        // catalog as nodes; everything the page needs rides one fan-out
        const [workflow, registry, sessions, models, githubLinked] = await Promise.all([
            call<Workflow>("get_workflow", { id }),
            call<RegistryEntryRow[]>("list_registry"),
            // chats are not registry rows but they are catalog entries — the
            // chip that grants an agent a persistent conversation
            call<SessionRow[]>("saturn_list_sessions"),
            // one entry per connected provider; [] = nothing connected (the
            // toolbox hints at settings), an entry with no models = fetch failed
            call<ProviderModels[]>("list_models"),
            call<boolean>("has_github_pat"),
        ]);
        return { workflow, registry, sessions, models, githubLinked };
    }, [id]);

    // live:false — a background cron run firing `data-changed` would hand the
    // designer a fresh userCatalog array mid-edit, breaking every memoized
    // Node's props for nothing. Registry edits here refetch explicitly (reload).
    const { data, error, loading, reload } = useAsync(load, { live: false });

    // nonce 0 is "never opened in this window", the only state where there is no
    // designer at all — so a user who never visits one pays nothing. A close
    // (workflow deleted) returns here.
    if (!nonce) return null;

    return (
        // `hidden` wins over the flex classes, so this is display:none when
        // another tab is showing and a full-height column slot when it isn't.
        <div className={hidden ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
            {loading || error || !data ? (
                <div className={"flex flex-1 items-center justify-center"}>
                    {loading ? (
                        <Loading what={"loading designer"} />
                    ) : (
                        <ErrorNote error={error ?? "no such workflow"} retry={reload} />
                    )}
                </div>
            ) : (
                <Designer
                    // the graph seeds a reducer at mount, so switching workflows
                    // without leaving the route has to remount rather than re-render
                    key={data.workflow.id}
                    active={!hidden}
                    openNonce={nonce}
                    workflow={data.workflow}
                    userCatalog={[
                        ...buildUserCatalog(data.registry),
                        ...data.sessions.map((s) => sessionEntry(s.id, s.name)),
                    ]}
                    // variables for the toolbox split — name + secret flag + whether a
                    // value is set. For secrets the value never reaches the client (value
                    // is '' from the guarded projection); regular variables carry their
                    // viewable plaintext.
                    variables={data.registry
                        .filter((r) => r.kind === "variable")
                        .map((r) => ({
                            id: r.id,
                            name: r.name,
                            secret: r.secret,
                            hasValue: r.has_token,
                            value: r.value,
                        }))}
                    models={data.models}
                    githubLinked={data.githubLinked}
                    onRegistryChange={reload}
                />
            )}
        </div>
    );
}
