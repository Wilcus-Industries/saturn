"use client";

import { useState } from "react";
import Field from "@/app/dashboard/field";
import ModalShell from "@/app/dashboard/modalShell";
import { call } from "@/lib/ipc";
import type { RegistryEntryRow } from "@/lib/registry";
import ToolListEditor from "./toolListEditor";

// add ("+ add server") or edit ("edit") trigger + modal for one MCP server
export default function McpEntryModal({
    entry,
    onSaved,
}: {
    entry?: RegistryEntryRow;
    onSaved: () => void;
}) {
    // controlled — React resets uncontrolled fields after a form action, which
    // would wipe the user's input when the action returns an error
    const [name, setName] = useState("");
    const [serverUrl, setServerUrl] = useState("");
    const [authToken, setAuthToken] = useState("");
    const [clearToken, setClearToken] = useState(false);

    return (
        <ModalShell
            wide
            title={entry ? "edit mcp server" : "new mcp server"}
            submitLabel={entry ? "save →" : "add →"}
            action={async (formData: FormData) => {
                try {
                    await call<string>("save_mcp_server", {
                        id: entry?.id ?? null,
                        name: String(formData.get("name") ?? ""),
                        serverUrl: String(formData.get("serverUrl") ?? ""),
                        authToken: String(formData.get("authToken") ?? ""),
                        clearToken: formData.get("clearToken") === "on",
                        tools: String(formData.get("tools") ?? "[]"),
                    });
                } catch (err) {
                    return { error: err instanceof Error ? err.message : "Save failed" };
                }
                onSaved();
            }}
            onOpen={() => {
                setName(entry?.name ?? "");
                setServerUrl(entry?.server_url ?? "");
                setAuthToken("");
                setClearToken(false);
            }}
            trigger={(open) =>
                entry ? (
                    <button
                        type={"button"}
                        onClick={open}
                        className={"font-mono text-sm text-blue-400"}
                    >
                        edit
                    </button>
                ) : (
                    <button
                        type={"button"}
                        onClick={open}
                        className={`self-start border border-dashed border-foreground/30 px-3 py-1.5
                            font-mono text-sm text-gray-400 transition-colors duration-200
                            hover:border-foreground hover:text-foreground`}
                    >
                        + add server
                    </button>
                )
            }
        >
            <Field
                label={"name"}
                name={"name"}
                required
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
            />

            <Field
                label={"server url (https)"}
                name={"serverUrl"}
                type={"url"}
                required
                placeholder={"https://mcp.example.com"}
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
            />

            <Field
                label={"auth token (optional)"}
                name={"authToken"}
                type={"password"}
                autoComplete={"off"}
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                placeholder={entry?.has_token ? "•••• token set — leave blank to keep" : ""}
            />

            {entry?.has_token && (
                <label className={"flex items-center gap-2 font-mono text-xs text-gray-400"}>
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
        </ModalShell>
    );
}
