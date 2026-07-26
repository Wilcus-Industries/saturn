"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { OpenrouterModel } from "@/app/dashboard/workflows/designer/designer";
import { call, ErrorNote, Loading, useAsync } from "@/lib/ipc";
import AgentChat from "../agentChat";
import { getSessionId, setSession, subscribe } from "../agentChatStore";
import SessionPicker, { type SessionRow } from "./sessionPicker";

// module-level so it is stable for useAsync — nothing here depends on props.
// null models = no OpenRouter key stored; the chat says so above the composer.
const load = () =>
    Promise.all([
        call<SessionRow[]>("saturn_list_sessions"),
        call<OpenrouterModel[] | null>("list_openrouter_models"),
    ]);

// the store is client-only, so the prerendered HTML has no session
const noSession = () => "";

// Saturn Agent — the app's front door, and the window's opening url. No Suspense
// boundary: nothing here reads useSearchParams.
export default function Agent() {
    const { data, error, loading, reload } = useAsync(load);
    const sessions = data?.[0];
    const sessionId = useSyncExternalStore(subscribe, getSessionId, noSession);

    // there is always exactly one session open. A fresh install has none; a
    // delete can remove the one being read; a reload starts with none selected.
    useEffect(() => {
        if (!sessions) return;
        if (sessions.length === 0) {
            void call("saturn_create_session", { name: null }).then(reload);
            return;
        }
        if (sessions.some((s) => s.id === sessionId)) return;
        const saved = localStorage.getItem("saturnSession");
        void setSession(sessions.find((s) => s.id === saved)?.id ?? sessions[0].id);
    }, [sessions, sessionId, reload]);

    return (
        // the exact height the shell leaves: 100dvh minus <main>'s p-8 (4rem)
        // and the layout's border-t. <main> therefore never scrolls and the
        // chat's own message list is the only scroller on the page.
        <div className={"flex h-[calc(100dvh-4rem-1px)] flex-col"}>
            {loading && <Loading what={"loading chat"} />}
            {error && <ErrorNote error={error} retry={reload} />}

            {sessions && sessionId && (
                <>
                    <SessionPicker
                        sessions={sessions}
                        current={sessionId}
                        onPick={(id) => void setSession(id)}
                        onChanged={reload}
                    />
                    <AgentChat models={data?.[1] ?? null} />
                </>
            )}
        </div>
    );
}
