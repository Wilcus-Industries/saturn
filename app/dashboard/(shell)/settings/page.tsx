import { notFound } from "next/navigation";
import McpLogo from "@/app/dashboard/mcpLogo";
import ActionButton from "@/app/dashboard/actionButton";
import ConnectAgent from "@/app/dashboard/connectAgent";
import { faviconDomain } from "@/lib/registry";
import { githubAppConfigured, listInstallations } from "@/lib/githubApp.server";
import { hasOpenrouterKey } from "@/lib/openrouter.server";
import { getUserRegistry } from "@/lib/registry.server";
import { SELF_HOSTED } from "@/lib/selfhost";
import { baseUrl, getSessionCached } from "@/lib/subscription";
import { deleteRegistryEntry, saveOpenrouterKey } from "./actions";
import ConnectButton from "./connectButton";
import ConfirmButton from "@/app/dashboard/confirmButton";
import McpEntryModal from "./mcpEntryModal";
import SkillModal from "./skillModal";
import UnlinkInstallationButton from "./unlinkInstallationButton";

export default async function Settings({
    searchParams,
}: {
    searchParams: Promise<{
        entry?: string;
        mcp_error?: string;
        github?: string;
        github_error?: string;
    }>;
}) {
    const session = await getSessionCached();
    if (!session?.user) notFound();

    // connect failures redirect back here with the message in the URL
    const {
        entry: errorEntryId,
        mcp_error: mcpError,
        github: githubStatus,
        github_error: githubError,
    } = await searchParams;

    // GitHub App card only exists when the operator has registered an app
    // (webhook secret + OAuth client). Unset → self-hosters / poller-only see
    // nothing, and no DB round trip for the installation list.
    const githubConfigured = githubAppConfigured();
    const installations = githubConfigured
        ? await listInstallations(session.user.id)
        : [];

    // independent reads — one Promise.all so the page pays the DB round trip once
    const [registry, keySet] = await Promise.all([
        getUserRegistry(session.user.id),
        hasOpenrouterKey(session.user.id),
    ]);
    const mcpServers = registry.filter((entry) => entry.kind === "mcp");
    const skills = registry.filter((entry) => entry.kind === "skill");

    return (
        <div className={"flex flex-col gap-6"}>
            <h1 className={"font-mono text-3xl"}>Settings</h1>

            {/* BYOK: the user's own OpenRouter key funds every model call */}
            <section className={"flex w-full flex-col gap-4 border border-foreground/15 p-4"}>
                <h2 className={"font-mono text-xl"}>Models</h2>

                <p className={"font-mono text-sm text-gray-400"}>
                    add an OpenRouter key to run models
                </p>

                <form action={saveOpenrouterKey} className={"flex flex-col gap-3"}>
                    <label className={"flex flex-col gap-1"}>
                        <span className={"font-mono text-xs text-gray-400"}>
                            openrouter api key
                        </span>
                        <input
                            name={"openrouterKey"}
                            type={"password"}
                            autoComplete={"off"}
                            placeholder={
                                keySet ? "•••• key set — leave blank to keep" : "sk-or-..."
                            }
                            className={"border border-foreground/15 bg-background p-2 font-mono text-sm"}
                        />
                    </label>

                    <div className={"flex items-center gap-4"}>
                        {keySet && (
                            <label
                                className={"flex items-center gap-2 font-mono text-xs text-gray-400"}
                            >
                                <input type={"checkbox"} name={"clearKey"} />
                                clear stored key
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
            </section>

            {/* user registry: entries become nodes in the workflow designer */}
            <section className={"flex w-full flex-col gap-4 border border-foreground/15 p-4"}>
                <h2 className={"font-mono text-xl"}>MCP servers</h2>

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
                                    <span className={"truncate font-mono text-xs text-gray-400"}>
                                        {faviconDomain(entry.server_url)}
                                    </span>
                                </div>
                                <div className={"ml-auto flex shrink-0 items-center gap-3"}>
                                    <McpEntryModal entry={entry} />
                                    <ConfirmButton id={entry.id} action={deleteRegistryEntry} />
                                </div>
                            </div>
                            <div
                                className={`flex flex-wrap items-center gap-x-4 gap-y-1 border-t
                                    border-foreground/15 px-3 py-2 font-mono text-xs
                                    text-gray-400`}
                            >
                                {entry.connected && (
                                    <span className={"text-green-500"}>● connected</span>
                                )}
                                {entry.has_token && <span>●●● token set</span>}
                                <span>
                                    {enabledTools}/{entry.tools.length} tools
                                </span>
                                {/* pulls tools/list; 401 navigates out to the
                                    server's OAuth flow and back here */}
                                <ConnectButton
                                    id={entry.id}
                                    label={
                                        entry.connected || entry.has_token
                                            ? "discover tools →"
                                            : "connect →"
                                    }
                                />
                            </div>
                            {mcpError && errorEntryId === entry.id && (
                                <p
                                    className={`border-t border-red-500/30 px-3 py-2 font-mono
                                        text-xs text-red-400`}
                                >
                                    {/* reflected from the URL (gated on the viewer's own entry
                                        id); collapse whitespace + hard-cap so it can't be shaped
                                        into fake multi-line UI */}
                                    {mcpError.replace(/\s+/g, " ").trim().slice(0, 200)}
                                </p>
                            )}
                        </div>
                    );
                })}

                <McpEntryModal />
            </section>

            <section className={"flex w-full flex-col gap-4 border border-foreground/15 p-4"}>
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
                            <SkillModal entry={entry} />
                            <ConfirmButton id={entry.id} action={deleteRegistryEntry} />
                        </div>
                    </div>
                ))}

                <SkillModal />
            </section>

            {/* central GitHub App: instant webhook delivery for github event
                nodes. Only rendered when the operator has registered the app. */}
            {githubConfigured && (
                <section
                    className={"flex w-full flex-col gap-4 border border-foreground/15 p-4"}
                >
                    <h2 className={"font-mono text-xl"}>GitHub App</h2>

                    <p className={"font-mono text-sm text-gray-400"}>
                        install on your repos — GitHub events arrive instantly instead of
                        polling. Private repos deliver only to the account that installs.
                    </p>

                    {githubStatus === "connected" && (
                        <p className={"font-mono text-sm text-green-500"}>
                            ● installation linked
                        </p>
                    )}
                    {githubError && (
                        <p className={"font-mono text-sm text-red-400"}>
                            {/* reflected from the URL — collapse whitespace + hard-cap so
                                it can't be shaped into fake multi-line UI */}
                            {githubError.replace(/\s+/g, " ").trim().slice(0, 200)}
                        </p>
                    )}

                    {installations.length === 0 && (
                        <p className={"font-mono text-sm text-gray-400"}>
                            no repositories linked yet
                        </p>
                    )}

                    {installations.map((inst) => (
                        <div
                            key={inst.installationId}
                            className={"flex items-center gap-3 border border-foreground/15 p-3"}
                        >
                            <div className={"flex min-w-0 flex-col"}>
                                <span className={"truncate font-mono text-sm"}>
                                    {inst.accountLogin || `installation ${inst.installationId}`}
                                </span>
                                <span className={"truncate font-mono text-xs text-gray-400"}>
                                    installation {inst.installationId}
                                </span>
                            </div>
                            <div className={"ml-auto shrink-0"}>
                                <UnlinkInstallationButton
                                    installationId={inst.installationId}
                                />
                            </div>
                        </div>
                    ))}

                    <a
                        href={"/api/github/install"}
                        className={`self-start rounded-full border border-foreground px-4 py-2
                            font-mono text-sm transition-colors duration-200
                            hover:bg-foreground hover:text-background`}
                    >
                        Install on GitHub →
                    </a>
                </section>
            )}

            <ConnectAgent
                baseUrl={baseUrl}
                selfHosted={SELF_HOSTED}
                mcpToken={process.env.SELF_HOSTED_MCP_TOKEN ?? ""}
            />
        </div>
    );
}
