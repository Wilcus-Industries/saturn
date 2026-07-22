// hosted MCP server at /mcp. Hosted mode: auth is the OAuth flow the agent
// runs itself, so this is purely a pointer. Self-hosted mode: OAuth is dead and
// agents connect with a static bearer token (SELF_HOSTED_MCP_TOKEN) passed as
// an Authorization header. Shared by overview + settings.
export default function ConnectAgent({
    baseUrl,
    selfHosted = false,
    mcpToken = "",
}: {
    baseUrl: string;
    selfHosted?: boolean;
    mcpToken?: string;
}) {
    // self-hosted with no token configured — nothing to connect with yet
    if (selfHosted && !mcpToken) {
        return (
            <section
                id={"connect-agent"}
                className={"flex w-full flex-col gap-4 border border-foreground/15 p-4"}
            >
                <h2 className={"font-mono text-xl"}>Connect an agent</h2>
                <p className={"font-mono text-sm text-yellow-500"}>
                    set SELF_HOSTED_MCP_TOKEN on the server to enable agent access
                </p>
            </section>
        );
    }

    const header = selfHosted ? ` --header "Authorization: Bearer ${mcpToken}"` : "";
    const commands: [string, string][] = selfHosted
        ? [
              ["claude code", `claude mcp add --transport http saturn ${baseUrl}/mcp${header}`],
              ["codex", `codex mcp add saturn --url ${baseUrl}/mcp${header}`],
              ["gemini cli", `gemini mcp add --transport http saturn ${baseUrl}/mcp${header}`],
              [
                  "vs code",
                  `code --add-mcp '{"name":"saturn","type":"http","url":"${baseUrl}/mcp","headers":{"Authorization":"Bearer ${mcpToken}"}}'`,
              ],
              [
                  "cursor (~/.cursor/mcp.json)",
                  `{ "mcpServers": { "saturn": { "url": "${baseUrl}/mcp", "headers": { "Authorization": "Bearer ${mcpToken}" } } } }`,
              ],
          ]
        : [
              ["claude code", `claude mcp add --transport http saturn ${baseUrl}/mcp`],
              ["codex", `codex mcp add saturn --url ${baseUrl}/mcp`],
              ["gemini cli", `gemini mcp add --transport http saturn ${baseUrl}/mcp`],
              ["vs code", `code --add-mcp '{"name":"saturn","type":"http","url":"${baseUrl}/mcp"}'`],
              [
                  "cursor (~/.cursor/mcp.json)",
                  `{ "mcpServers": { "saturn": { "url": "${baseUrl}/mcp" } } }`,
              ],
          ];

    return (
        <section id={"connect-agent"} className={"flex w-full flex-col gap-4 border border-foreground/15 p-4"}>
            <h2 className={"font-mono text-xl"}>Connect an agent</h2>
            <p className={"font-mono text-sm text-gray-400"}>
                {selfHosted
                    ? "edit and test-run your workflows agentically. Add Saturn as an MCP server with your access token."
                    : "edit and test-run your workflows agentically — add Saturn as an MCP server, then authenticate in the browser when prompted"}
            </p>
            {commands.map(([agent, command]) => (
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
    );
}
