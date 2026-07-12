"use client";

import { useEffect, useState } from "react";
import ActionButton from "@/app/dashboard/actionButton";
import type { RegistryEntryRow } from "@/lib/registry";
import { saveMcpServer } from "./actions";
import ToolListEditor from "./toolListEditor";

// add ("+ add server") or edit ("edit") trigger + modal for one MCP server
export default function McpEntryModal({ entry }: { entry?: RegistryEntryRow }) {
    const [open, setOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // controlled — React resets uncontrolled fields after a form action, which
    // would wipe the user's input when the action returns an error
    const [name, setName] = useState("");
    const [serverUrl, setServerUrl] = useState("");
    const [authToken, setAuthToken] = useState("");
    const [clearToken, setClearToken] = useState(false);

    const openModal = () => {
        setError(null);
        setName(entry?.name ?? "");
        setServerUrl(entry?.server_url ?? "");
        setAuthToken("");
        setClearToken(false);
        setOpen(true);
    };

    // Escape closes; listener only lives while the modal is open
    useEffect(() => {
        if (!open) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [open]);

    return (
        <>
            {entry ? (
                <button
                    type={"button"}
                    onClick={openModal}
                    className={"font-mono text-sm text-blue-400"}
                >
                    edit
                </button>
            ) : (
                <button
                    type={"button"}
                    onClick={openModal}
                    className={`self-start border border-dashed border-foreground/30 px-3 py-1.5
                        font-mono text-sm text-gray-400 transition-colors duration-200
                        hover:border-foreground hover:text-foreground`}
                >
                    + add server
                </button>
            )}

            {open && (
                <div
                    className={"fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"}
                    onClick={() => setOpen(false)}
                >
                    {/* clicks inside the panel must not reach the backdrop */}
                    <div
                        className={`max-h-[85vh] w-full max-w-lg overflow-y-auto border
                            border-foreground/15 bg-background p-6`}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <form
                            action={async (formData) => {
                                setError(null);
                                const result = await saveMcpServer(formData);
                                if (result) {
                                    setError(result.error);
                                    return;
                                }
                                setOpen(false);
                            }}
                            className={"flex flex-col gap-4"}
                        >
                            <h2 className={"font-mono text-xl"}>
                                {entry ? "edit mcp server" : "new mcp server"}
                            </h2>

                            {entry && <input type={"hidden"} name={"id"} value={entry.id} />}

                            <label className={"flex flex-col gap-1"}>
                                <span className={"font-mono text-xs text-gray-400"}>name</span>
                                <input
                                    name={"name"}
                                    required
                                    autoFocus
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    className={"border border-foreground/15 bg-background p-2 font-mono text-sm"}
                                />
                            </label>

                            <label className={"flex flex-col gap-1"}>
                                <span className={"font-mono text-xs text-gray-400"}>
                                    server url (https)
                                </span>
                                <input
                                    name={"serverUrl"}
                                    type={"url"}
                                    required
                                    placeholder={"https://mcp.example.com"}
                                    value={serverUrl}
                                    onChange={(e) => setServerUrl(e.target.value)}
                                    className={"border border-foreground/15 bg-background p-2 font-mono text-sm"}
                                />
                            </label>

                            <label className={"flex flex-col gap-1"}>
                                <span className={"font-mono text-xs text-gray-400"}>
                                    auth token (optional)
                                </span>
                                <input
                                    name={"authToken"}
                                    type={"password"}
                                    autoComplete={"off"}
                                    value={authToken}
                                    onChange={(e) => setAuthToken(e.target.value)}
                                    placeholder={
                                        entry?.has_token
                                            ? "•••• token set — leave blank to keep"
                                            : ""
                                    }
                                    className={"border border-foreground/15 bg-background p-2 font-mono text-sm"}
                                />
                            </label>

                            {entry?.has_token && (
                                <label
                                    className={"flex items-center gap-2 font-mono text-xs text-gray-400"}
                                >
                                    <input
                                        type={"checkbox"}
                                        name={"clearToken"}
                                        checked={clearToken}
                                        onChange={(e) => setClearToken(e.target.checked)}
                                    />
                                    clear stored token
                                </label>
                            )}

                            <ToolListEditor initial={entry?.tools ?? []} />

                            {error && (
                                <p className={"font-mono text-xs text-red-400"}>{error}</p>
                            )}

                            <ActionButton
                                className={`self-end rounded-full border border-foreground px-4 py-2
                                    font-mono text-sm transition-colors duration-200
                                    hover:bg-foreground hover:text-background`}
                            >
                                {entry ? "save →" : "add →"}
                            </ActionButton>
                        </form>
                    </div>
                </div>
            )}
        </>
    );
}
