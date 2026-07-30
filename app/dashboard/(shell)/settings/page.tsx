"use client";

import { useCallback, useState } from "react";
import ConfirmButton from "@/app/dashboard/confirmButton";
import EntryModal from "@/app/dashboard/entryModal";
import { Download } from "@/app/dashboard/icons";
import McpLogo from "@/app/dashboard/mcpLogo";
import { call, ErrorNote, Loading, useAsync } from "@/lib/ipc";
import { faviconDomain, type RegistryEntryRow } from "@/lib/registry";
import BuiltinToolsCard from "./builtinToolsCard";
import ConnectButton from "./connectButton";
import McpEntryModal from "./mcpEntryModal";
import ProviderModal, { type ProviderStatus } from "./providerModal";
import SecretForm from "./secretForm";

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

// import a skill from a file instead of pasting one in: the native open panel
// (`plugin:dialog|open`, same one-invoke call the composer's cwd chip makes),
// then Rust reads the file — front matter for the name, the body as the
// instructions.
function ImportSkillButton({ onSaved }: { onSaved: () => void }) {
    const [error, setError] = useState<string | null>(null);

    return (
        <>
            <button
                type={"button"}
                onClick={async () => {
                    setError(null);
                    try {
                        const picked = await call<string | null>("plugin:dialog|open", {
                            options: {
                                multiple: false,
                                filters: [{ name: "Skill", extensions: ["md", "markdown", "txt"] }],
                            },
                        });
                        // null is a cancelled panel, not a failure
                        if (typeof picked !== "string") return;
                        await call("import_skill", { path: picked });
                    } catch (err) {
                        setError(err instanceof Error ? err.message : "Import failed");
                        return;
                    }
                    onSaved();
                }}
                className={`flex items-center gap-2 self-start border border-dashed
                    border-foreground/30 px-3 py-1.5 font-mono text-sm text-gray-400
                    transition-colors duration-200 hover:border-foreground hover:text-foreground`}
            >
                <Download className={"h-3.5 w-3.5"} />
                import skill
            </button>
            {error && <p className={"font-mono text-xs text-red-400"}>{error}</p>}
        </>
    );
}

export default function Settings() {
    const load = useCallback(
        async () =>
            Promise.all([
                call<RegistryEntryRow[]>("list_registry"),
                call<ProviderStatus[]>("provider_status", { refresh: false }),
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
        async (id: string) => {
            setDeleteError(null);
            try {
                await call<boolean>("delete_registry_entry", { id });
            } catch (err) {
                setDeleteError(err instanceof Error ? err.message : "Delete failed");
                return;
            }
            reload();
        },
        [reload],
    );

    const [registry = [], providers = [], patSet = false, autostart = false] = data ?? [];
    const saturn = registry.find((entry) => entry.kind === "saturn");
    const mcpServers = registry.filter((entry) => entry.kind === "mcp");
    const skills = registry.filter((entry) => entry.kind === "skill");

    return (
        <div className={"flex flex-col gap-6"}>
            <h1 className={"font-mono text-3xl"}>Settings</h1>

            {deleteError && <ErrorNote error={deleteError} />}

            {/* one gate for the whole page: the registry, the provider statuses
                and the PAT are local reads that land in the same tick, so four
                independent placeholders would just be four pulsing lines */}
            {loading && <Loading what={"loading settings"} />}
            {error && <ErrorNote error={error} retry={reload} />}

            {data && (
                <>
                    {/* one tile per model provider; greyed means not connected,
                        and clicking it is how you connect */}
                    <section
                        className={"flex w-full flex-col gap-4 border border-foreground/15 p-4"}
                    >
                        <h2 className={"font-mono text-xl"}>Models</h2>

                        <p className={"font-mono text-sm text-gray-400"}>
                            connect a provider to run models — click a tile for its setup
                        </p>

                        {/* wrap, don't grid: a grid stretches two tiles across
                            the section's full width, leaving them marooned in
                            their columns. These pack left and wrap like text,
                            which is also what stops the row re-flowing when a
                            third provider lands */}
                        <div className={"flex flex-wrap gap-3"}>
                            {providers.map((provider) => (
                                <ProviderModal
                                    key={provider.id}
                                    provider={provider}
                                    reload={reload}
                                />
                            ))}
                        </div>
                    </section>

                    {/* user registry: entries become nodes in the workflow designer */}
                    <section
                        className={"flex w-full flex-col gap-4 border border-foreground/15 p-4"}
                    >
                        <h2 className={"font-mono text-xl"}>Tools</h2>

                        <p className={"font-mono text-sm text-gray-400"}>
                            what agents can act with — Saturn&apos;s own tools, plus any mcp server
                            you add. server sign-in happens in your browser, only servers
                            needing a pre-registered OAuth client want a manual auth token
                        </p>

                        {saturn && <BuiltinToolsCard entry={saturn} onSaved={reload} />}

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
                                            <ConfirmButton onConfirm={() => remove(entry.id)} />
                                        </div>
                                    </div>
                                    <div
                                        className={`flex flex-wrap items-center gap-x-4 gap-y-1 border-t
                                            border-foreground/15 px-3 py-2 font-mono text-xs
                                            text-gray-400`}
                                    >
                                        {entry.has_token && <span>●●● token set</span>}
                                        {entry.connected && <span>signed in</span>}
                                        <span>
                                            {enabledTools}/{entry.tools.length} tools
                                        </span>
                                        <ConnectButton
                                            id={entry.id}
                                            label={
                                                entry.has_token || entry.connected
                                                    ? "discover tools →"
                                                    : "connect →"
                                            }
                                            onDiscovered={reload}
                                        />
                                    </div>
                                </div>
                            );
                        })}

                        {mcpServers.length === 0 && (
                            <p className={"font-mono text-sm text-gray-400"}>
                                no mcp servers yet — add one for tools beyond the builtins
                            </p>
                        )}

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
                                    <EntryModal kind={"skill"} entry={entry} onSaved={reload} />
                                    <ConfirmButton onConfirm={() => remove(entry.id)} />
                                </div>
                            </div>
                        ))}

                        <div className={"flex flex-wrap items-center gap-3"}>
                            <EntryModal kind={"skill"} onSaved={reload} />
                            <ImportSkillButton onSaved={reload} />
                        </div>
                    </section>

                    {/* the central GitHub App is gone — one fine-grained read-only
                        PAT in the Keychain now covers every github event node */}
                    <section
                        className={"flex w-full flex-col gap-4 border border-foreground/15 p-4"}
                    >
                        <h2 className={"font-mono text-xl"}>GitHub</h2>

                        <p className={"font-mono text-sm text-gray-400"}>
                            optional - add a personal access token for higher rate limits on GitHub.
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
