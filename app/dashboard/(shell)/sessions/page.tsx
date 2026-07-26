"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import ConfirmButton from "@/app/dashboard/confirmButton";
import { call, ErrorNote, Loading, useAsync } from "@/lib/ipc";
import { setSession } from "../agentChatStore";
import type { SessionRow } from "../agent/sessionPicker";
import { relativeTime } from "../workflows/workflowCard";

// module-level so it is stable for useAsync — nothing here depends on props
const load = () => call<SessionRow[]>("saturn_list_sessions");

// Every Saturn Agent chat: the ones started in the app, and the ones a workflow
// writes into through an agent node's session port. Same four commands the
// picker dropdown drives — this is the surface that shows what is IN them.
export default function Sessions() {
    const { data, error, loading, reload } = useAsync(load);
    const router = useRouter();
    const [editing, setEditing] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    const [err, setErr] = useState("");

    // a taken name is the common failure and the user typed it, so it cannot
    // fail silently — same shape as the picker's `run`
    const run = (p: Promise<unknown>) =>
        void p.then(
            () => {
                setErr("");
                reload();
            },
            (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
        );

    // the chat surfaces read the session out of the module store, so pick it
    // before navigating rather than passing an id the page would have to parse
    const open = (id: string) => {
        void setSession(id);
        router.push("/dashboard/agent/");
    };

    return (
        <div className={"flex flex-col gap-6"}>
            <div className={"flex items-center justify-between"}>
                <h1 className={"font-mono text-3xl"}>Sessions</h1>
                <button
                    type={"button"}
                    onClick={() => run(call<SessionRow>("saturn_create_session", { name: null }))}
                    className={
                        "border border-foreground/15 px-3 py-1.5 font-mono text-xs " +
                        "transition-colors duration-200 hover:bg-foreground hover:text-background"
                    }
                >
                    + new chat
                </button>
            </div>

            <p className={"font-mono text-sm text-gray-400"}>
                every conversation with Saturn Agent. wire one into an agent node&apos;s session
                port in the designer and that agent keeps talking here — its runs read the chat
                back and append to it.
            </p>

            {loading && <Loading what={"loading sessions"} />}
            {error && <ErrorNote error={error} retry={reload} />}
            {err && <p className={"font-mono text-sm text-red-400"}>{err}</p>}

            {data && data.length === 0 && (
                <p className={"font-mono text-sm text-gray-400"}>no chats yet</p>
            )}

            <div className={"flex flex-col border-t border-foreground/15"}>
                {(data ?? []).map((s) => (
                    <div
                        key={s.id}
                        className={
                            "flex items-center gap-4 border-b border-foreground/15 py-2.5 " +
                            "font-mono text-sm"
                        }
                    >
                        {editing === s.id ? (
                            <input
                                autoFocus
                                value={draft}
                                aria-label={"Chat name"}
                                className={
                                    "min-w-0 flex-1 border border-foreground/15 bg-transparent " +
                                    "px-1 font-mono text-sm outline-none"
                                }
                                onChange={(e) => setDraft(e.target.value)}
                                onBlur={() => setEditing(null)}
                                onKeyDown={(e) => {
                                    if (e.key === "Escape") setEditing(null);
                                    if (e.key !== "Enter") return;
                                    setEditing(null);
                                    run(call("saturn_rename_session", { id: s.id, name: draft }));
                                }}
                            />
                        ) : (
                            <button
                                type={"button"}
                                onClick={() => open(s.id)}
                                className={"min-w-0 flex-1 truncate text-left hover:underline"}
                            >
                                {s.name}
                            </button>
                        )}
                        <span className={"shrink-0 text-xs text-gray-400"}>
                            {s.messages} {s.messages === 1 ? "msg" : "msgs"}
                        </span>
                        <span className={"w-24 shrink-0 text-right text-xs text-gray-400"}>
                            {relativeTime(s.updatedAt)}
                        </span>
                        <button
                            type={"button"}
                            onClick={() => {
                                setDraft(s.name);
                                setEditing(s.id);
                            }}
                            className={
                                "shrink-0 text-xs text-gray-400 transition-colors duration-200 " +
                                "hover:text-foreground"
                            }
                        >
                            rename
                        </button>
                        <ConfirmButton
                            sizeClass={"text-xs"}
                            onConfirm={() => run(call("saturn_delete_session", { id: s.id }))}
                        />
                        <button
                            type={"button"}
                            onClick={() => open(s.id)}
                            className={
                                "shrink-0 text-xs text-gray-400 transition-colors duration-200 " +
                                "hover:text-foreground"
                            }
                        >
                            open →
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
}
