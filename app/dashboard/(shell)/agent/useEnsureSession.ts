"use client";

import { useEffect } from "react";
import { call } from "@/lib/ipc";
import { getSessionId, setSession } from "../agentChatStore";
import type { SessionRow } from "./sessionPicker";

/// There is always exactly one chat open, on whichever surface got here first —
/// the dashboard page or the designer's docked panel. A fresh install has no
/// session at all, a delete can remove the one being read, and a reload starts
/// with none selected, so both surfaces run this against their own list. One
/// copy, because it was two and they had the same bug.
///
/// **The list is the only trigger**, and the open chat is read imperatively
/// rather than subscribed. That is the whole correctness argument: a rescue is
/// for "the list changed and no longer holds the open chat", never for "the store
/// switched to something this list has not caught up with". The second is every
/// freshly created chat — the creator selects it immediately, before the refetch
/// lands, so an effect that also fired on the switch found the new id missing
/// from the stale list and threw the user back to `sessions[0]`. Put `sessionId`
/// back in the deps and `+ new chat` stops moving anywhere.
export function useEnsureSession(sessions: SessionRow[] | undefined, reload: () => void) {
    useEffect(() => {
        if (!sessions) return;
        if (sessions.length === 0) {
            void call("saturn_create_session", { name: null }).then(reload);
            return;
        }
        if (sessions.some((s) => s.id === getSessionId())) return;
        const saved = localStorage.getItem("saturnSession");
        void setSession(sessions.find((s) => s.id === saved)?.id ?? sessions[0].id);
    }, [sessions, reload]);
}
