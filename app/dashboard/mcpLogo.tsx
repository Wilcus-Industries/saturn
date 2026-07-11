"use client";

import { useState } from "react";

// favicon for a user-registered MCP server, keyed by its URL's hostname;
// falls back to an initial-letter tile when the favicon service has nothing
export default function McpLogo({
    domain,
    name,
    size,
}: {
    domain: string;
    name: string;
    size: 16 | 32;
}) {
    const [failed, setFailed] = useState(false);
    const px = size === 16 ? "h-4 w-4" : "h-8 w-8"; // literal classes for Tailwind

    if (failed) {
        return (
            <span
                aria-hidden
                className={`flex ${px} shrink-0 items-center justify-center bg-foreground
                    font-mono ${size === 16 ? "text-[10px]" : "text-sm"} text-background`}
            >
                {(name.charAt(0) || "?").toUpperCase()}
            </span>
        );
    }

    return (
        // third-party favicon; plain <img> since remotePatterns isn't
        // configured for next/image (matches the settings avatar)
        // eslint-disable-next-line @next/next/no-img-element
        <img
            src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`}
            alt={`${name} logo`}
            referrerPolicy={"no-referrer"}
            onError={() => setFailed(true)}
            className={`${px} shrink-0`}
        />
    );
}
