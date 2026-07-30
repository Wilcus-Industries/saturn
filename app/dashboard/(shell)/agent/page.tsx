"use client";

import { useSyncExternalStore } from "react";
import type { ProviderModels } from "@/app/dashboard/workflows/designer/designer";
import { call, ErrorNote, Loading, useAsync } from "@/lib/ipc";
import AgentChat from "../agentChat";
import { getSessionId, setSession, subscribe } from "../agentChatStore";
import type { SessionRow } from "./sessionPicker";
import SessionSidebar from "./sessionSidebar";
import { useEnsureSession } from "./useEnsureSession";

// module-level so it is stable for useAsync — nothing here depends on props.
// no model groups = no provider connected; the chat says so above the composer.
const load = () =>
    Promise.all([
        call<SessionRow[]>("saturn_list_sessions"),
        call<ProviderModels[]>("list_models"),
    ]);

// the store is client-only, so the prerendered HTML has no session
const noSession = () => "";

// Saturn Agent — the app's front door, and the window's opening url. No Suspense
// boundary: nothing here reads useSearchParams.
export default function Agent() {
    const { data, error, loading, reload } = useAsync(load);
    const sessions = data?.[0];
    const sessionId = useSyncExternalStore(subscribe, getSessionId, noSession);

    useEnsureSession(sessions, reload);

    return (
        // The one page that fills the window rather than sitting in the content
        // column, because the sidebar belongs against the window's left edge.
        //
        // w-screen off left-1/2 lands on both window edges: the column this
        // breaks out of is centered in <main>, so its center IS the window's
        // center — which a static -mx-8 cannot match, since what max-w-5xl
        // leaves over is a function of the window width. <main> carries the
        // matching overflow-x-hidden. Sound only because the shell is a bar
        // ABOVE <main> with nothing beside it; put a rail back and this paints
        // over it.
        //
        // Height is the viewport less the top bar's h-12 and one border each
        // from the shell's border-t and the bar's border-b. -my-8 then cancels
        // <main>'s p-8, so what this box CONSUMES is exactly <main>'s content
        // height and no scrollbar appears — the chat's message list stays the
        // only scroller on the page. Every term is a class in
        // (shell)/layout.tsx or topBar.tsx; change one there and this goes
        // stale. Do not "fix" the negative margin by growing the height: that
        // is what hangs the box past <main>'s padding box.
        <div
            className={
                "relative left-1/2 -my-8 flex h-[calc(100dvh-3rem-2px)] w-screen " +
                "-translate-x-1/2"
            }
        >
            {/* the transcript is gated on the SESSION only, never on this fetch:
                the store already holds the conversation, `load` includes
                `list_models` (a blocking network command that re-probes every
                30s), and blanking the chat until that lands is what made a turn
                look like it had died on every navigation back here */}
            {sessions && sessionId && (
                <SessionSidebar
                    sessions={sessions}
                    current={sessionId}
                    onPick={(id) => void setSession(id)}
                    onChanged={reload}
                />
            )}

            {/* the chat takes what the sidebar leaves; its transcript and
                composer center themselves on their own max-w-2xl, so losing the
                shell's max-w-5xl costs nothing. The notes ride above it here
                rather than beside the sidebar */}
            <div className={"flex min-w-0 flex-1 flex-col px-8 pb-4"}>
                {loading && !sessionId && <Loading what={"loading chat"} />}
                {error && <ErrorNote error={error} retry={reload} />}
                {sessionId && <AgentChat models={data?.[1]} />}
            </div>
        </div>
    );
}
