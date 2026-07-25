"use client";

import { useCallback, useState } from "react";
import ActionButton from "@/app/dashboard/actionButton";
import ConfirmButton from "@/app/dashboard/confirmButton";
import McpLogo from "@/app/dashboard/mcpLogo";
import { call, ErrorNote, Loading, useAsync } from "@/lib/ipc";
import { faviconDomain, type RegistryEntryRow } from "@/lib/registry";
import ConnectButton from "./connectButton";
import McpEntryModal from "./mcpEntryModal";
import SkillModal from "./skillModal";

// the two Keychain-backed secrets on this page are the same form twice: a
// password field, a clear checkbox that only exists once something is stored,
// and a save. Write-only both ways — the value never comes back over IPC, so
// blank means "keep" and there is nothing to prefill.
function SecretForm({
    field,
    placeholder,
    isSet,
    cmd,
    onSaved,
}: {
    field: string;
    placeholder: string;
    isSet: boolean;
    cmd: string;
    onSaved: () => void;
}) {
    const [error, setError] = useState<string | null>(null);

    return (
        <form
            className={"flex flex-col gap-3"}
            action={async (formData: FormData) => {
                setError(null);
                try {
                    // Rust writes the value verbatim, so the trim happens here —
                    // an accidental space must read as "keep", not overwrite
                    await call(cmd, {
                        value: String(formData.get("value") ?? "").trim(),
                        clear: formData.get("clear") === "on",
                    });
                } catch (err) {
                    setError(err instanceof Error ? err.message : "Save failed");
                    return;
                }
                onSaved();
            }}
        >
            <label className={"flex flex-col gap-1"}>
                <span className={"font-mono text-xs text-gray-400"}>{field}</span>
                <input
                    name={"value"}
                    type={"password"}
                    autoComplete={"off"}
                    placeholder={isSet ? "•••• set — leave blank to keep" : placeholder}
                    className={"border border-foreground/15 bg-background p-2 font-mono text-sm"}
                />
            </label>

            {error && <p className={"font-mono text-xs text-red-400"}>{error}</p>}

            <div className={"flex items-center gap-4"}>
                {isSet && (
                    <label className={"flex items-center gap-2 font-mono text-xs text-gray-400"}>
                        <input type={"checkbox"} name={"clear"} />
                        clear stored value
                    </label>
                )}
                <ActionButton
                    className={`ml-auto rounded-full border border-foreground px-4 py-2
                        font-mono text-sm transition-colors duration-200
                        hover:bg-foreground hover:text-background`}
                >
                    save →
                </ActionButton>
            </div>
        </form>
    );
}

// the login item, which is a Keychain-shaped thing without being one: the state
// lives outside the database (a LaunchAgent plist), so it is read back from the
// system rather than remembered, and a failed write must not leave the checkbox
// showing what the user clicked instead of what actually happened.
function AutostartToggle({ enabled, onChanged }: { enabled: boolean; onChanged: () => void }) {
    const [error, setError] = useState<string | null>(null);

    return (
        <>
            <label className={"flex items-center gap-2 font-mono text-sm"}>
                <input
                    type={"checkbox"}
                    checked={enabled}
                    onChange={async (e) => {
                        setError(null);
                        try {
                            await call("set_autostart", { enabled: e.target.checked });
                        } catch (err) {
                            setError(err instanceof Error ? err.message : "Could not change");
                        }
                        onChanged();
                    }}
                />
                start Saturn when I log in
            </label>
            {error && <p className={"font-mono text-xs text-red-400"}>{error}</p>}
        </>
    );
}

export default function Settings() {
    const load = useCallback(
        async () =>
            Promise.all([
                call<RegistryEntryRow[]>("list_registry"),
                call<boolean>("has_openrouter_key"),
                call<boolean>("has_github_pat"),
                call<boolean>("autostart_enabled"),
            ]),
        [],
    );
    const { data, error, loading, reload } = useAsync(load);

    // ConfirmButton has no error slot of its own, so a failed delete surfaces
    // at the top of the page rather than vanishing
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const remove = useCallback(
        async (formData: FormData) => {
            setDeleteError(null);
            try {
                await call<boolean>("delete_registry_entry", { id: String(formData.get("id") ?? "") });
            } catch (err) {
                setDeleteError(err instanceof Error ? err.message : "Delete failed");
                return;
            }
            reload();
        },
        [reload],
    );

    const [registry = [], keySet = false, patSet = false, autostart = false] = data ?? [];
    const mcpServers = registry.filter((entry) => entry.kind === "mcp");
    const skills = registry.filter((entry) => entry.kind === "skill");

    return (
        <div className={"flex flex-col gap-6"}>
            <h1 className={"font-mono text-3xl"}>Settings</h1>

            {deleteError && <ErrorNote error={deleteError} />}

            {/* one gate for the whole page: the registry, the OpenRouter key and
                the PAT are three local reads that land in the same tick, so four
                independent placeholders would just be four pulsing lines */}
            {loading && <Loading what={"loading settings"} />}
            {error && <ErrorNote error={error} retry={reload} />}

            {data && (
                <>
                    {/* BYOK: the user's own OpenRouter key funds every model call */}
                    <section
                        className={"flex w-full flex-col gap-4 border border-foreground/15 p-4"}
                    >
                        <h2 className={"font-mono text-xl"}>Models</h2>

                        <p className={"font-mono text-sm text-gray-400"}>
                            add an OpenRouter key to run models
                        </p>

                        <SecretForm
                            field={"openrouter api key"}
                            placeholder={"sk-or-..."}
                            isSet={keySet}
                            cmd={"set_openrouter_key"}
                            onSaved={reload}
                        />
                    </section>

                    {/* user registry: entries become nodes in the workflow designer */}
                    <section
                        className={"flex w-full flex-col gap-4 border border-foreground/15 p-4"}
                    >
                        <h2 className={"font-mono text-xl"}>MCP servers</h2>

                        <p className={"font-mono text-sm text-gray-400"}>
                            servers that sign you in with OAuth aren&apos;t supported yet — set an
                            auth token instead
                        </p>

                        {mcpServers.length === 0 && (
                            <p className={"font-mono text-sm text-gray-400"}>no mcp servers yet</p>
                        )}

                        {mcpServers.map((entry) => {
                            const enabledTools = entry.tools.filter((t) => t.enabled).length;
                            return (
                                <div
                                    key={entry.id}
                                    className={"flex flex-col border border-foreground/15"}
                                >
                                    <div className={"flex items-center gap-3 p-3"}>
                                        <McpLogo
                                            domain={faviconDomain(entry.server_url)}
                                            name={entry.name}
                                            size={32}
                                        />
                                        <div className={"flex min-w-0 flex-col"}>
                                            <span className={"truncate font-mono text-sm"}>
                                                {entry.name}
                                            </span>
                                            <span
                                                className={"truncate font-mono text-xs text-gray-400"}
                                            >
                                                {faviconDomain(entry.server_url)}
                                            </span>
                                        </div>
                                        <div className={"ml-auto flex shrink-0 items-center gap-3"}>
                                            <McpEntryModal entry={entry} onSaved={reload} />
                                            <ConfirmButton id={entry.id} action={remove} />
                                        </div>
                                    </div>
                                    <div
                                        className={`flex flex-wrap items-center gap-x-4 gap-y-1 border-t
                                            border-foreground/15 px-3 py-2 font-mono text-xs
                                            text-gray-400`}
                                    >
                                        {entry.has_token && <span>●●● token set</span>}
                                        <span>
                                            {enabledTools}/{entry.tools.length} tools
                                        </span>
                                        <ConnectButton
                                            id={entry.id}
                                            label={entry.has_token ? "discover tools →" : "connect →"}
                                            onDiscovered={reload}
                                        />
                                    </div>
                                </div>
                            );
                        })}

                        <McpEntryModal onSaved={reload} />
                    </section>

                    <section
                        className={"flex w-full flex-col gap-4 border border-foreground/15 p-4"}
                    >
                        <h2 className={"font-mono text-xl"}>Skills</h2>

                        {skills.length === 0 && (
                            <p className={"font-mono text-sm text-gray-400"}>no skills yet</p>
                        )}

                        {skills.map((entry) => (
                            <div
                                key={entry.id}
                                className={"flex items-center gap-3 border border-foreground/15 p-3"}
                            >
                                <span className={"text-2xl"}>{entry.emoji}</span>
                                <div className={"flex min-w-0 flex-col"}>
                                    <span className={"truncate font-mono text-sm"}>{entry.name}</span>
                                    {entry.description && (
                                        <span className={"truncate font-mono text-xs text-gray-400"}>
                                            {entry.description}
                                        </span>
                                    )}
                                </div>
                                <div className={"ml-auto flex shrink-0 items-center gap-3"}>
                                    <SkillModal entry={entry} onSaved={reload} />
                                    <ConfirmButton id={entry.id} action={remove} />
                                </div>
                            </div>
                        ))}

                        <SkillModal onSaved={reload} />
                    </section>

                    {/* the central GitHub App is gone — one fine-grained read-only
                        PAT in the Keychain now covers every github event node */}
                    <section
                        className={"flex w-full flex-col gap-4 border border-foreground/15 p-4"}
                    >
                        <h2 className={"font-mono text-xl"}>GitHub</h2>

                        <p className={"font-mono text-sm text-gray-400"}>
                            optional — public repos poll fine without a token, at 60 requests/hour
                            shared across every watch instead of 5,000. github-star watches are the
                            exception: one of them spends ~120 requests/hour on its own, so they
                            need a token to work at all.
                        </p>

                        <SecretForm
                            field={"fine-grained personal access token (read-only)"}
                            placeholder={"github_pat_..."}
                            isSet={patSet}
                            cmd={"set_github_pat"}
                            onSaved={reload}
                        />
                    </section>

                    <section
                        className={"flex w-full flex-col gap-4 border border-foreground/15 p-4"}
                    >
                        <h2 className={"font-mono text-xl"}>Startup</h2>

                        <p className={"font-mono text-sm text-gray-400"}>
                            closing the window hides Saturn to the menu bar — schedules keep firing
                            and the Discord, Telegram and GitHub watches stay connected. quit from
                            the menu bar icon to actually stop them.
                        </p>

                        <AutostartToggle enabled={autostart} onChanged={reload} />

                        <p className={"font-mono text-xs text-gray-400"}>
                            this records the path Saturn is running from, so move it to
                            /Applications before switching it on
                        </p>
                    </section>
                </>
            )}
        </div>
    );
}
