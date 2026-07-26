"use client";

import { useState } from "react";
import Spinner from "@/app/dashboard/spinner";
import { call } from "@/lib/ipc";

// pulls tools/list for one MCP server and merges the result into its stored
// allowlist. A server that answers 401 sends the user through OAuth first — the
// browser opens, Rust waits on a loopback redirect, and the spinner runs for the
// whole of it. Only a server that reaches 401 *with* a stored credential comes
// back needing a manual token.
const NEEDS_TOKEN = "MCP server requires authorization";

export default function ConnectButton({
    id,
    label,
    onDiscovered,
}: {
    id: string;
    label: string;
    onDiscovered: () => void;
}) {
    const [status, setStatus] = useState<{ text: string; bad: boolean } | null>(null);
    const [pending, setPending] = useState(false);

    return (
        <>
            {status && (
                <span
                    className={`font-mono text-xs ${status.bad ? "text-red-400" : "text-green-500"}`}
                    role={status.bad ? "alert" : undefined}
                >
                    {status.text}
                </span>
            )}
            <button
                type={"button"}
                disabled={pending}
                aria-busy={pending}
                className={"ml-auto text-blue-400"}
                onClick={async () => {
                    setStatus(null);
                    setPending(true);
                    let count: number;
                    try {
                        count = await call<number>("discover_mcp_tools", { id });
                    } catch (err) {
                        const raw = err instanceof Error ? err.message : "Connection failed";
                        // an MCP server's error body can be arbitrarily long and
                        // multi-line — collapse and cap so it can't shape the card
                        const msg = raw.replace(/\s+/g, " ").trim().slice(0, 200);
                        setStatus({
                            text:
                                msg === NEEDS_TOKEN
                                    ? `${msg} — edit the server and set an auth token`
                                    : msg,
                            bad: true,
                        });
                        return;
                    } finally {
                        setPending(false);
                    }
                    setStatus({ text: `${count} tool${count === 1 ? "" : "s"} found`, bad: false });
                    onDiscovered();
                }}
            >
                {pending ? <Spinner /> : label}
            </button>
        </>
    );
}
