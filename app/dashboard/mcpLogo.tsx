"use client";

import { useState } from "react";

// favicon for a user-registered MCP server, keyed by its URL's hostname;
// falls back to an initial-letter tile when the favicon service has nothing.
// "fill" stretches to the parent (mcp grant chips) — rounded to nest inside
// the chip's rounded-xl border-2 box, which can't overflow-hidden without
// clipping its edge-straddling output port
export default function McpLogo({
    domain,
    name,
    size,
    round = false,
}: {
    domain: string;
    name: string;
    size: 16 | 32 | "fill";
    // clip to a circle — for logos sitting inside circular nodes (an opaque
    // rounded-square favicon like Telegram's reads as a square otherwise)
    round?: boolean;
}) {
    // s2 → (own icon, when the server is this app itself) → letter tile.
    // Google s2 has no favicon indexed for this deployment's domain, so a
    // user registering saturn's own MCP server would get the letter tile;
    // the same-origin app icon is CSP-safe (img-src 'self').
    const [stage, setStage] = useState<"s2" | "self" | "tile">("s2");
    const failed = stage === "tile";
    const selfHosted = () =>
        typeof window !== "undefined" &&
        (window.location.hostname === domain || window.location.hostname.endsWith(`.${domain}`));
    // literal classes for Tailwind
    const px = `${size === 16 ? "h-4 w-4" : size === 32 ? "h-8 w-8" : "h-full w-full"} ${
        round ? "rounded-full" : size === "fill" ? "rounded-[10px]" : ""
    }`;

    if (failed) {
        return (
            <span
                aria-hidden
                className={`flex ${px} shrink-0 items-center justify-center bg-foreground
                    font-mono ${size === 16 ? "text-[10px]" : size === 32 ? "text-sm" : "text-xl"} text-background`}
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
            src={
                stage === "self"
                    ? "/icon.png"
                    : `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size === "fill" ? 128 : 64}`
            }
            alt={`${name} logo`}
            referrerPolicy={"no-referrer"}
            draggable={false}
            onError={() => setStage(stage === "s2" && selfHosted() ? "self" : "tile")}
            className={`${px} shrink-0 object-cover`}
        />
    );
}
