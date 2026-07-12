// hosted MCP server at /mcp — auth is the OAuth flow the agent
// runs itself, so this is purely a pointer (shared by overview + settings)
export default function ConnectAgent({ baseUrl }: { baseUrl: string }) {
    return (
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
    );
}
