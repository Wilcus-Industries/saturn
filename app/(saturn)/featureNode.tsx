import Reveal from "./reveal";

// feature cards drawn in the designer's node language — colored left accent
// bar, `:: name` mono title, port dot — hung off a dashed flow spine that
// starts at a `:: start` chip. Accent classes stay literal for Tailwind.
const FEATURES = [
    {
        name: "designer",
        accent: "bg-yellow-500",
        desc: "Drag nodes, wire edges, hit run. Undo, autosave, keyboard shortcuts, live console output.",
    },
    {
        name: "agent",
        accent: "bg-cyan-400",
        desc: "An LLM loop with a system prompt and scoped tool grants. Returns text, or a generated image.",
    },
    {
        name: "mcp",
        accent: "bg-purple-400",
        desc: "Connect any MCP server — OAuth or token. Every enabled tool becomes a node, with per-tool read/write grants.",
    },
    {
        name: "skills",
        accent: "bg-yellow-500",
        desc: "Reusable instructions you grant to agents. Write once, load anywhere.",
    },
    {
        name: "cron",
        accent: "bg-cyan-400",
        desc: "Schedules down to every minute. Run history, logs, and status on every workflow.",
    },
    {
        name: "models",
        accent: "bg-purple-400",
        desc: "300+ models through OpenRouter. Bring your own key today; built-in credits soon.",
    },
] as const;

export default function FeaturesGraph() {
    return (
        <Reveal className={"relative mt-6"}>
            <span
                aria-hidden
                className={"landing-spine absolute left-0 top-2 bottom-6 border-l border-dashed border-gray-400/60"}
            />
            <div className={"pl-6 sm:pl-10 flex flex-col gap-6"}>
                <span className={`landing-reveal-item relative self-start inline-flex items-center gap-2
                                  border border-foreground bg-background px-2.5 py-1 font-mono text-xs`}>
                    <span aria-hidden className={"absolute -left-1 top-1/2 -translate-y-1/2 size-2 rounded-full bg-yellow-500"} />
                    :: start
                </span>
                <ul className={"grid gap-4 md:grid-cols-2"}>
                    {FEATURES.map((f, i) => (
                        <li
                            key={f.name}
                            className={`landing-reveal-item relative border border-foreground bg-background
                                        p-3 pl-4 hover:bg-foreground/5`}
                            style={{ transitionDelay: `${(i + 1) * 70}ms` }}
                        >
                            <span aria-hidden className={`absolute left-0 inset-y-0 w-1 ${f.accent}`} />
                            <span aria-hidden className={`absolute -left-1 top-4 size-2 rounded-full border border-background ${f.accent}`} />
                            <h3 className={"font-mono text-sm"}>:: {f.name}</h3>
                            <p className={"font-sans text-sm text-foreground/80 mt-1.5"}>{f.desc}</p>
                        </li>
                    ))}
                </ul>
            </div>
        </Reveal>
    );
}
