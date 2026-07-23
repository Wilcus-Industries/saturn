// feature cards drawn in the designer's node language — monochrome left
// accent bar, `:: name` mono title, port dot. The parent <Reveal> (page.tsx)
// tags the block `landing-revealed`, staggering the cards in.
const FEATURES: { name: string; desc: string; wide?: true }[] = [
    {
        name: "designer",
        desc: "Drag nodes, wire edges, hit run. Undo, autosave, live console, plain and secret variables.",
    },
    {
        name: "agent",
        desc: "An LLM loop with scoped tool grants. Returns text or an image.",
    },
    {
        name: "sandboxes",
        desc: "A persistent Linux box per user. Agents get a real shell, and files survive between runs.",
    },
    {
        name: "memory",
        desc: "Persistent pgvector stores. Agents save and recall context across runs and workflows.",
    },
    {
        name: "mcp",
        desc: "Connect any MCP server: every tool becomes a node. Saturn serves its own at /mcp for outside agents.",
    },
    {
        name: "skills",
        desc: "Reusable instructions you grant to agents. Write once, load anywhere.",
    },
    {
        name: "integrations",
        desc: "Discord and Telegram nodes: post messages, and trigger workflows on real-time events. Build real bots.",
    },
    {
        name: "cron",
        desc: "Schedules down to every minute. Run history and logs on every workflow.",
    },
    {
        name: "models",
        wide: true,
        desc: "300+ models through OpenRouter. Built-in credits on paid plans, or bring your own key.",
    },
];

export default function FeatureGrid() {
    return (
        <ul className={"grid gap-3 sm:grid-cols-2"}>
            {FEATURES.map((f, i) => (
                <li
                    key={f.name}
                    className={`landing-reveal-item relative border border-foreground bg-background
                                p-3 pl-4 hover:bg-foreground/5 ${f.wide ? "sm:col-span-2" : ""}`}
                    style={{ transitionDelay: `${i * 60}ms` }}
                >
                    <span aria-hidden className={"absolute left-0 inset-y-0 w-1 bg-foreground"} />
                    <span aria-hidden className={"absolute -left-1 top-4 size-2 rounded-full border border-background bg-foreground"} />
                    <h3 className={"font-mono text-sm"}>:: {f.name}</h3>
                    <p className={"font-sans text-sm leading-relaxed text-foreground/70 mt-1.5"}>{f.desc}</p>
                </li>
            ))}
        </ul>
    );
}
