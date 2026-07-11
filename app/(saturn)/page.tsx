import PageTransition from "./pageTransition";
import GetStartedLink from "./getStartedLink";
import DemoWindow from "./demoWindow";
import FeaturesGraph from "./featureNode";
import TierCard from "./activate/tierCard";

// one line of saturn's rings seen edge-on — the section divider
function RingDivider() {
    return (
        <div aria-hidden
             className={"overflow-hidden whitespace-nowrap font-mono text-xs leading-none text-gray-400/40 select-none"}>
            {"═".repeat(105) + "≡≡≡≣≣▓▓▒▒░░··"}
        </div>
    );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
    return <p className={"font-mono text-xs text-gray-400"}>{children}</p>;
}

export default function Home() {
    return (
        <PageTransition>
            <div className={"absolute top-5 left-5 right-5 z-10 pl-3 flex flex-col gap-3"}>
                <h1 className={"text-5xl font-mono"}>Saturn</h1>
                <p className={"w-full max-w-100 font-sans"}>
                    Agentic automations, anywhere and anytime.
                </p>
                <p className={"w-full max-w-100 font-sans"}>
                    Orchestrate automations using the Saturn node designer.
                </p>
                <p className={"w-full max-w-100 font-sans"}>
                    Transparent pricing through us (300+ models), or bring your own keys.
                </p>
                <p className={"w-full max-w-100 font-sans"}>
                    Fully open-source on <a href={"https://github.com/Wilcus-Industries/saturn"}
                       className={"text-blue-400"}>
                        GitHub
                    </a>.
                </p>
                <div className={"flex flex-row gap-2"}>
                    <GetStartedLink className={`text-background bg-foreground w-30
                                                p-1 flex items-center justify-center
                                                hover:bg-background hover:text-foreground
                                                border-foreground border duration-200
                                                transition-colors`}>
                        <h1>Get Started</h1>
                    </GetStartedLink>
                    <GetStartedLink
                            className={`w-30 p-1 flex items-center justify-center
                                        bg-background border-foreground border
                                        hover:bg-foreground hover:text-background
                                        transition-colors duration-200 cursor-pointer`}>
                        <h1>Sign In</h1>
                    </GetStartedLink>
                </div>
            </div>
            {/* scroll hint pinned to the bottom of the first screen (the
                layout's h-dvh scene div), nodding toward the landing body */}
            <a href={"#learn-more"}
               className={`absolute left-1/2 -translate-x-1/2 top-[calc(100dvh-2.75rem)] z-10
                           flex items-center gap-2 font-mono text-xs text-gray-600 dark:text-gray-400
                           hover:text-foreground transition-colors duration-200`}>
                :: learn_more
                <span aria-hidden className={"learn-more-nudge"}>▾</span>
            </a>
            {/* landing body below the saturn sky — rendered in the designer's
                own node language so the marketing reads as the product */}
            <section id={"learn-more"} className={"min-h-dvh bg-background relative"}>
                <div className={"max-w-5xl px-8 py-24 flex flex-col gap-20"}>

                    <div className={"flex flex-col gap-3"}>
                        <Eyebrow>:: demo</Eyebrow>
                        <h2 className={"text-3xl sm:text-4xl font-mono"}>Wire agents into workflows.</h2>
                        <p className={"w-full max-w-100 font-sans"}>
                            Drop agents, tools, and logic onto a canvas and wire them together.
                            Saturn runs the graph on your schedule.
                        </p>
                        <DemoWindow />
                    </div>

                    <RingDivider />

                    <div className={"flex flex-col gap-3"}>
                        <Eyebrow>:: features</Eyebrow>
                        <h2 className={"text-3xl sm:text-4xl font-mono"}>Every piece is a node.</h2>
                        <p className={"w-full max-w-100 font-sans"}>
                            Everything below sits in the designer&apos;s toolbox — grab it and wire it in.
                        </p>
                        <FeaturesGraph />
                    </div>

                    <RingDivider />

                    <div className={"flex flex-col gap-3"}>
                        <Eyebrow>:: activate</Eyebrow>
                        <h2 className={"text-3xl sm:text-4xl font-mono"}>Pick your orbit.</h2>
                        <p className={"w-full max-w-100 font-sans"}>
                            Tiers set platform limits — workflows, MCP servers, schedule frequency.
                            Models are yours either way.
                        </p>
                        <div className={"mt-6 flex flex-wrap gap-6"}>
                            <div className={"flex-1 min-w-72"}><TierCard tier={"free"} interactive={false} /></div>
                            <div className={"flex-1 min-w-72"}><TierCard tier={"pro"} interactive={false} /></div>
                            <div className={"flex-1 min-w-72"}><TierCard tier={"max"} interactive={false} /></div>
                        </div>

                        <span aria-hidden className={"ml-4 h-10 border-l border-dashed border-gray-400/60"} />
                        <div className={"relative border border-foreground bg-background p-4 pl-5 w-full max-w-100"}>
                            <span aria-hidden className={"absolute left-0 inset-y-0 w-1 bg-foreground"} />
                            <span aria-hidden className={"absolute -left-1 top-4 size-2 rounded-full border border-background bg-foreground"} />
                            <h3 className={"font-mono text-sm"}>:: get_started</h3>
                            <p className={"font-sans text-sm text-foreground/80 mt-1.5"}>Free tier. No card.</p>
                            <div className={"mt-3 flex flex-row gap-2"}>
                                <GetStartedLink className={`text-background bg-foreground w-30
                                                            p-1 flex items-center justify-center
                                                            hover:bg-background hover:text-foreground
                                                            border-foreground border duration-200
                                                            transition-colors`}>
                                    <span>Get Started</span>
                                </GetStartedLink>
                                <GetStartedLink
                                        className={`w-30 p-1 flex items-center justify-center
                                                    bg-background border-foreground border
                                                    hover:bg-foreground hover:text-background
                                                    transition-colors duration-200 cursor-pointer`}>
                                    <span>Sign In</span>
                                </GetStartedLink>
                            </div>
                        </div>

                        <div className={"mt-12 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-gray-400"}>
                            <a href={"https://github.com/Wilcus-Industries/saturn"} className={"text-blue-400"}>
                                GitHub
                            </a>
                            <span aria-hidden>·</span>
                            <span>© 2026 Wilcus Industries.</span>
                        </div>
                    </div>

                </div>
            </section>
        </PageTransition>
    );
}
