"use client";

import { useState } from "react";
import { RiRobot2Line } from "react-icons/ri";

// OpenRouter model ids are "<author>/<slug>" — map known authors to an apex
// domain for the same Google s2 favicon lookup mcpLogo.tsx uses. s2 serves a
// generic globe (not a 404) for unknown domains, so unmapped authors skip the
// fetch and render the robot fallback directly.
const AUTHOR_DOMAINS: Record<string, string> = {
    ai21: "ai21.com",
    amazon: "amazon.com",
    anthropic: "anthropic.com",
    baidu: "baidu.com",
    bytedance: "bytedance.com",
    cohere: "cohere.com",
    deepseek: "deepseek.com",
    google: "google.com",
    inflection: "inflection.ai",
    liquid: "liquid.ai",
    "meta-llama": "meta.com",
    microsoft: "microsoft.com",
    minimax: "minimax.io",
    mistralai: "mistral.ai",
    moonshotai: "moonshot.ai",
    nvidia: "nvidia.com",
    openai: "openai.com",
    perplexity: "perplexity.ai",
    qwen: "alibabacloud.com",
    "x-ai": "x.ai",
    "z-ai": "z.ai",
};

export const modelAuthorDomain = (slug: string): string | null =>
    AUTHOR_DOMAINS[slug.split("/")[0]] ?? null;

// literal classes for Tailwind
const PX = { 16: "h-4 w-4", 32: "h-8 w-8", 48: "h-12 w-12", 72: "h-18 w-18" } as const;

// company favicon for an openrouter model slug; unknown author or a failed
// favicon load falls back to a generic robot icon
export default function ModelLogo({
    slug,
    name,
    size,
}: {
    slug: string;
    name: string;
    size: 16 | 32 | 48 | 72;
}) {
    // track the failing domain (not a boolean) so an editable node whose
    // slug changes to a new author retries the favicon
    const [failed, setFailed] = useState<string | null>(null);
    const domain = modelAuthorDomain(slug);

    if (!domain || failed === domain) {
        // the fallback keeps some air — a line icon flush against the circle
        // edge reads as a glyph soup, unlike a favicon
        return (
            <span
                aria-hidden
                className={`pointer-events-none flex ${PX[size]} shrink-0 select-none items-center justify-center text-foreground/40`}
            >
                <RiRobot2Line className={"h-[62%] w-[62%]"} />
            </span>
        );
    }

    return (
        // third-party favicon; plain <img> since remotePatterns isn't
        // configured for next/image (matches mcpLogo.tsx)
        // eslint-disable-next-line @next/next/no-img-element
        <img
            src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`}
            alt={`${name} logo`}
            referrerPolicy={"no-referrer"}
            draggable={false}
            onError={() => setFailed(domain)}
            // pointer-events-none: the logo must never intercept the node's
            // drag gesture or become a native image drag
            className={`pointer-events-none ${PX[size]} shrink-0 select-none`}
        />
    );
}
