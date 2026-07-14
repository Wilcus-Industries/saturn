import type { Metadata } from "next";
import Link from "next/link";
import PageTransition from "./pageTransition";
import GetStartedLink from "./getStartedLink";
import DemoWindow from "./demoWindow";
import FeatureGrid from "./featureNode";
import Reveal from "./reveal";
import { GITHUB_URL, ORG_NAME, SITE_DESCRIPTION, SITE_NAME, siteUrl } from "@/lib/seo";

export const metadata: Metadata = {
    alternates: { canonical: "/" },
};

// structured data for the landing page — offer prices must stay in sync with
// TIERS in app/(saturn)/activate/tierCard.tsx
const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
        {
            "@type": "Organization",
            "@id": `${siteUrl}/#org`,
            name: ORG_NAME,
            url: siteUrl,
            logo: `${siteUrl}/icon.png`,
            sameAs: [GITHUB_URL],
        },
        {
            "@type": "WebSite",
            "@id": `${siteUrl}/#website`,
            name: SITE_NAME,
            url: siteUrl,
            publisher: { "@id": `${siteUrl}/#org` },
        },
        {
            "@type": "SoftwareApplication",
            name: SITE_NAME,
            url: siteUrl,
            description: SITE_DESCRIPTION,
            applicationCategory: "DeveloperApplication",
            operatingSystem: "Web",
            softwareHelp: GITHUB_URL,
            offers: [
                { "@type": "Offer", name: "Saturn Free", price: "0", priceCurrency: "USD" },
                { "@type": "Offer", name: "Saturn Pro", price: "19", priceCurrency: "USD" },
                { "@type": "Offer", name: "Saturn Max", price: "79", priceCurrency: "USD" },
            ],
        },
    ],
};

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
            <script
                type="application/ld+json"
                dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
            />
            <div className={"absolute top-5 left-5 right-5 z-10 pl-3 flex flex-col gap-3"}>
                <h1 className={"text-5xl font-mono"}>Saturn</h1>
                <p className={"w-full max-w-100 font-sans"}>
                    Agentic automations, anywhere and anytime.
                </p>
                <p className={"w-full max-w-100 font-sans"}>
                    Orchestrate automations using the Saturn node designer.
                </p>
                <p className={"w-full max-w-100 font-sans"}>
                    Fully open-source on <a href={"https://github.com/Wilcus-Industries/saturn"}
                       target={"_blank"} rel={"noopener noreferrer"}
                       className={"underline underline-offset-4 hover:text-gray-400 transition-colors"}>
                        GitHub
                    </a>.
                </p>
                <p className={"w-full max-w-100 font-sans"}>
                    Get started for free today with 1000 free credits to use with 300+ models.
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
            {/* landing body below the saturn sky — one full-viewport monochrome
                section rendered in the designer's own node language so the
                marketing reads as the product */}
            <section id={"learn-more"} className={"relative flex min-h-dvh flex-col bg-background"}>
                <RingDivider />
                <div className={"mx-auto flex w-full max-w-6xl flex-1 flex-col justify-between gap-8 px-8 py-6 sm:py-8"}>

                    <div className={"flex flex-col gap-3"}>
                        <Eyebrow>:: features</Eyebrow>
                        <h2 className={"text-3xl sm:text-4xl font-mono"}>Every piece is a node.</h2>
                        <p className={"max-w-xl font-sans text-foreground/70"}>
                            Agents, tools, and schedules — drop them on a canvas, wire them
                            together, and Saturn runs the graph on your schedule.
                        </p>
                    </div>

                    <Reveal className={"grid items-center gap-8 lg:grid-cols-2"}>
                        <FeatureGrid />
                        <DemoWindow />
                    </Reveal>

                    <div className={"flex flex-col gap-6"}>
                        <div className={"flex flex-wrap items-center gap-3"}>
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
                            <span className={"font-mono text-xs text-gray-400"}>free tier · no card</span>
                        </div>
                        <div className={"flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-gray-400"}>
                            <a href={"https://github.com/Wilcus-Industries/saturn"}
                               target={"_blank"} rel={"noopener noreferrer"}
                               className={"underline underline-offset-4 hover:text-foreground transition-colors"}>
                                GitHub
                            </a>
                            <span aria-hidden>·</span>
                            <Link href={"/terms"}
                                  className={"underline underline-offset-4 hover:text-foreground transition-colors"}>
                                Terms
                            </Link>
                            <span aria-hidden>·</span>
                            <Link href={"/privacy"}
                                  className={"underline underline-offset-4 hover:text-foreground transition-colors"}>
                                Privacy
                            </Link>
                            <span aria-hidden>·</span>
                            <span>© 2026 Wilcus Industries.</span>
                        </div>
                    </div>

                </div>
            </section>
        </PageTransition>
    );
}
