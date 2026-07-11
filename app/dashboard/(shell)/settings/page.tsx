import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import McpLogo from "@/app/dashboard/mcpLogo";
import { auth } from "@/lib/auth";
import ActionButton from "@/app/dashboard/actionButton";
import { faviconDomain } from "@/lib/registry";
import { hasOpenrouterKey } from "@/lib/openrouter.server";
import { getUserRegistry } from "@/lib/registry.server";
import { baseUrl, getActivationDetails } from "@/lib/subscription";
import { discoverMcpTools, saveOpenrouterKey } from "./actions";
import DeleteEntryButton from "./deleteEntryButton";
import McpEntryModal from "./mcpEntryModal";
import SkillModal from "./skillModal";

export default async function Settings({
    searchParams,
}: {
    searchParams: Promise<{ entry?: string; mcp_error?: string }>;
}) {
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });
    if (!session?.user) redirect("/onboard");

    // connect failures redirect back here with the message in the URL
    const { entry: errorEntryId, mcp_error: mcpError } = await searchParams;

    const { level, status, pendingCancel, periodEnd } =
        await getActivationDetails(requestHeaders);
    const { name, email, image, createdAt } = session.user;

    const registry = await getUserRegistry(session.user.id);
    const keySet = await hasOpenrouterKey(session.user.id);
    const mcpServers = registry.filter((entry) => entry.kind === "mcp");
    const skills = registry.filter((entry) => entry.kind === "skill");

    async function logout() {
        "use server";
        await auth.api.signOut({ headers: await headers() });
        redirect("/");
    }

    return (
        <div className={"flex flex-col gap-6"}>
            <h1 className={"font-mono text-3xl"}>Settings</h1>

            <section className={"flex w-full flex-col gap-4 border border-foreground/15 p-4"}>
                <h2 className={"font-mono text-xl"}>Account</h2>

                <div className={"grid gap-4 md:grid-cols-2"}>
                    <div className={"flex items-center gap-4 border border-foreground/15 p-4"}>
                        {image ? (
                            // avatar comes from the OAuth provider; plain <img> since
                            // remotePatterns isn't configured for next/image
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                                src={image}
                                alt={`${name}'s profile picture`}
                                referrerPolicy={"no-referrer"}
                                className={"h-16 w-16 rounded-full"}
                            />
                        ) : (
                            <div
                                className={`flex h-16 w-16 items-center justify-center rounded-full
                                    bg-foreground font-mono text-2xl text-background`}
                            >
                                {name.charAt(0).toUpperCase()}
                            </div>
                        )}
                        <div className={"flex min-w-0 flex-col"}>
                            <span className={"truncate font-sans text-lg"}>{name}</span>
                            <span className={"truncate font-mono text-sm text-gray-400"}>
                                {email}
                            </span>
                            <span className={"font-mono text-sm text-gray-400"}>
                                member since{" "}
                                {new Date(createdAt).toLocaleDateString("en-US", {
                                    month: "long",
                                    year: "numeric",
                                })}
                            </span>
                        </div>
                    </div>

                    {/* echoes the activate-page tier cards; informational, so no hover invert */}
                    <div
                        className={`flex flex-col gap-3 border border-foreground/15 bg-background p-4
                            ${level === "max" ? "enchant-glow text-purple-300"
                            : level === "pro" ? "pro-glow text-yellow-500" : ""}`}
                    >
                        <div className={"flex items-center gap-3 border-b border-current pb-2"}>
                            <h3 className={"font-mono"}>
                                {level
                                    ? `Saturn ${level.charAt(0).toUpperCase()}${level.slice(1)}`
                                    : "No plan"}
                            </h3>
                            {status && <small className={"ml-auto font-mono"}>{status}</small>}
                        </div>
                        {pendingCancel && (
                            <p className={"font-mono text-sm text-gray-400"}>
                                expires{" "}
                                {periodEnd
                                    ? periodEnd.toLocaleDateString("en-US", {
                                          month: "long",
                                          day: "numeric",
                                          year: "numeric",
                                      })
                                    : "at period end"}
                            </p>
                        )}
                        <Link
                            href={"/dashboard/upgrade"}
                            className={"mt-auto font-mono text-sm text-blue-400"}
                        >
                            {level === "pro" || level === "max" ? "Manage →" : "Upgrade →"}
                        </Link>
                    </div>
                </div>

                <form action={logout} className={"sm:self-end"}>
                    <button
                        type={"submit"}
                        className={`w-full border border-red-500 bg-background p-2 sm:w-auto sm:px-6
                            transition-colors duration-200 hover:bg-red-600 hover:text-white`}
                    >
                        Log out
                    </button>
                </form>
            </section>

            {/* TEMPORARY: BYO OpenRouter key until the built-in token system lands */}
            <section className={"flex w-full flex-col gap-4 border border-foreground/15 p-4"}>
                <h2 className={"font-mono text-xl"}>Models</h2>
                <p className={"font-mono text-sm text-gray-400"}>
                    workflows use your OpenRouter key to run models — temporary
                    until Saturn tokens land
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
                                    <DeleteEntryButton id={entry.id} />
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
                                {/* pulls tools/list; 401 redirects out to the
                                    server's OAuth flow and back here */}
                                <form action={discoverMcpTools} className={"ml-auto"}>
                                    <input type={"hidden"} name={"id"} value={entry.id} />
                                    <ActionButton className={"text-blue-400"}>
                                        {entry.connected || entry.has_token
                                            ? "discover tools →"
                                            : "connect →"}
                                    </ActionButton>
                                </form>
                            </div>
                            {mcpError && errorEntryId === entry.id && (
                                <p
                                    className={`border-t border-red-500/30 px-3 py-2 font-mono
                                        text-xs text-red-400`}
                                >
                                    {mcpError.slice(0, 300)}
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
                            <DeleteEntryButton id={entry.id} />
                        </div>
                    </div>
                ))}

                <SkillModal />
            </section>

            {/* hosted MCP server at /mcp — auth is the OAuth flow the agent
                runs itself, so this is purely a pointer */}
            <section className={"flex w-full flex-col gap-4 border border-foreground/15 p-4"}>
                <h2 className={"font-mono text-xl"}>Connect an agent</h2>
                <p className={"font-mono text-sm text-gray-400"}>
                    edit and test-run your workflows agentically — add Saturn as an
                    MCP server, then authenticate in the browser when prompted
                </p>
                {[
                    ["claude code", `claude mcp add --transport http saturn ${baseUrl}/mcp`],
                    ["codex", `codex mcp add saturn --url ${baseUrl}/mcp`],
                    ["gemini cli", `gemini mcp add --transport http saturn ${baseUrl}/mcp`],
                    ["vs code", `code --add-mcp '{"name":"saturn","type":"http","url":"${baseUrl}/mcp"}'`],
                    ["cursor (~/.cursor/mcp.json)", `{ "mcpServers": { "saturn": { "url": "${baseUrl}/mcp" } } }`],
                ].map(([agent, command]) => (
                    <div key={agent} className={"flex flex-col gap-1"}>
                        <span className={"font-mono text-xs text-gray-400"}>{agent}</span>
                        <code
                            className={`overflow-x-auto border border-foreground/15 bg-foreground/5
                                p-3 font-mono text-sm whitespace-nowrap`}
                        >
                            {command}
                        </code>
                    </div>
                ))}
            </section>
        </div>
    );
}
