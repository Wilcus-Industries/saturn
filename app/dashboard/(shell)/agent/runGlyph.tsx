"use client";

import { useSyncExternalStore } from "react";
import Spinner from "@/app/dashboard/spinner";
import { getFinished, getRunning, subscribe } from "../agentChatStore";

// the store is client-only, so the prerendered HTML has nothing running
const none = () => "";

/// One session's status as one mono cell — same width in all three states, so a
/// turn starting or landing never reflows the row it sits in:
///
///   - braille spinner — that chat's turn is in flight
///   - green ● — its reply landed while the user was reading another chat
///   - hollow ○ — idle, which is also what the green becomes once visited
///
/// Shared by both chat switchers — the page's sidebar and the designer panel's
/// dropdown — because the two have to read identically, and the only way to
/// guarantee that is one component. Subscribes per glyph: `emit()` is global and
/// fires on every delta frame regardless, so hoisting the snapshot buys nothing.
///
/// Done is the only state that announces itself: `aria-busy` on the control
/// beside it already covers running, and nothing else would say a reply is
/// waiting — colour alone cannot.
export default function RunGlyph({ id }: { id: string }) {
    const running = useSyncExternalStore(subscribe, getRunning, none).split(" ").includes(id);
    const done = useSyncExternalStore(subscribe, getFinished, none).split(" ").includes(id);

    if (running) return <Spinner className={"shrink-0 text-gray-400"} />;

    return done ? (
        <span role={"img"} aria-label={"reply ready"} className={"shrink-0 text-green-400"}>
            ●
        </span>
    ) : (
        <span aria-hidden className={"shrink-0 text-gray-400/60"}>
            ○
        </span>
    );
}
