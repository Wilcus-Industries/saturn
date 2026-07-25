"use client";

import { useState } from "react";
import ActionButton from "@/app/dashboard/actionButton";
import { call } from "@/lib/ipc";

// pulls tools/list for one MCP server and merges the result into its stored
// allowlist. The OAuth hand-off is gone: starting a PKCE flow needs a redirect
// target a desktop app doesn't have yet, so a 401 comes back as an ordinary
// connect error and the way through is a manual auth token.
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
            <form
                className={"ml-auto"}
                action={async () => {
                    setStatus(null);
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
                    }
                    setStatus({ text: `${count} tool${count === 1 ? "" : "s"} found`, bad: false });
                    onDiscovered();
                }}
            >
                <ActionButton className={"text-blue-400"}>{label}</ActionButton>
            </form>
        </>
    );
}
