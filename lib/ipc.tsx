"use client";

// The one seam between the React app and the Rust backend. Everything that used
// to be a server action, a server component's `db.query`, or a `fetch` to
// `app/api/` comes through here.
//
// Two shapes, because the backend speaks in exactly two:
//
//   `call()`   — request/response, over Tauri IPC. Replaces server actions.
//   `onEvent()`— Rust pushing without being asked. Replaces the NDJSON stream
//                and, in a roundabout way, `revalidatePath`.
//
// On `revalidatePath`: there is deliberately no equivalent. A mutation the user
// just made is awaited by the caller, so the caller refetches — no invalidation
// bus needed. The only changes nobody asked for are the ones the *background*
// makes (a cron firing, a Discord message landing), and those arrive as
// `data-changed`, which `useAsync` already listens for. 23 revalidatePath calls
// collapse to one event and an await.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/// Every Rust command returns `Result<T, String>`; Tauri rejects with the raw
/// string, which is not an Error and so loses its message through most of
/// React's error paths. Normalize once, here.
export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    try {
        return await invoke<T>(cmd, args);
    } catch (err) {
        throw new Error(typeof err === "string" ? err : String(err));
    }
}

/// Fire-and-forget for the paths that genuinely cannot await (unmount flushes).
export const callVoid = (cmd: string, args?: Record<string, unknown>) => {
    void call(cmd, args).catch(() => {});
};

export const onEvent = <T,>(name: string, fn: (payload: T) => void) =>
    listen<T>(name, (e) => fn(e.payload));

/// Payload of the `run-log` event Rust pushes while a run executes, and the
/// shape stored in `workflow_run.log`. Lives here because this is the seam it
/// crosses. kind "image": text is a data:image/… URL — the designer console
/// renders it inline; a stored run log keeps a placeholder instead.
/// fixtures/interpreter.ts declares its own copy on purpose: the oracle must
/// not depend on the app.
export type ConsoleLine = { kind: "print" | "info" | "warn" | "error" | "image"; text: string };

/// Emitted by Rust after any background mutation — a scheduled run finishing, an
/// event delivering. NOT emitted for IPC mutations: the caller of those already
/// knows, and echoing them back would make every save refetch twice.
const DATA_CHANGED = "data-changed";

export type Async<T> = {
    data: T | undefined;
    error: string | undefined;
    /// True only until the FIRST load resolves. A background refetch keeps the
    /// stale rows on screen rather than flashing the skeleton again — the whole
    /// reason this isn't just `data === undefined`.
    loading: boolean;
    reload: () => void;
};

/// The client-fetch replacement for a server component's `await db.query(...)`.
/// Pass a stable `load` (wrap it in useCallback) — it is the dependency.
export function useAsync<T>(load: () => Promise<T>, opts?: { live?: boolean }): Async<T> {
    // Omit<Async<T>, "reload"> rather than an inline optional-field shape: with
    // `data?: T` the spread below produces a type whose `data` key is optional,
    // which does not satisfy `Async<T>`'s required-but-undefined `data`.
    const [state, setState] = useState<Omit<Async<T>, "reload">>({
        data: undefined,
        error: undefined,
        loading: true,
    });
    // guards against a slow first request resolving after a fast second one and
    // overwriting it — the classic client-fetch race a server component can't have
    const seq = useRef(0);
    const live = opts?.live ?? true;

    const run = useCallback(() => {
        const mine = ++seq.current;
        load().then(
            (data) => {
                if (seq.current === mine) setState({ data, error: undefined, loading: false });
            },
            (err: unknown) => {
                // keep the last good `data` on a failed refetch — a transient
                // error should not blank a page that was rendering fine
                if (seq.current === mine) {
                    setState((prev) => ({
                        ...prev,
                        error: err instanceof Error ? err.message : String(err),
                        loading: false,
                    }));
                }
            },
        );
    }, [load]);

    useEffect(run, [run]);

    useEffect(() => {
        if (!live) return;
        // listen() resolves to the unlisten fn asynchronously; if the effect is
        // torn down first, unlisten as soon as it arrives
        let stop: (() => void) | undefined;
        let dead = false;
        void listen(DATA_CHANGED, () => run()).then((un) => {
            if (dead) un();
            else stop = un;
        });
        return () => {
            dead = true;
            stop?.();
        };
    }, [live, run]);

    return { ...state, reload: run };
}

/// Shared placeholder for the gap server components didn't have. Deliberately
/// plain text rather than shimmering boxes: every page here is monospace rows on
/// a dark ground, and a skeleton that doesn't match its content reads worse than
/// one line that admits what it's doing.
export function Loading({ what = "loading" }: { what?: string }) {
    return (
        <p
            className={`font-mono text-sm text-gray-400 motion-safe:animate-pulse`}
            aria-live={"polite"}
        >
            {what}…
        </p>
    );
}

export function ErrorNote({ error, retry }: { error: string; retry?: () => void }) {
    return (
        <p className={"font-mono text-sm text-red-500"} role={"alert"}>
            {error}
            {retry && (
                <button
                    type={"button"}
                    onClick={retry}
                    className={"ml-3 underline underline-offset-4 hover:text-foreground"}
                >
                    retry
                </button>
            )}
        </p>
    );
}
