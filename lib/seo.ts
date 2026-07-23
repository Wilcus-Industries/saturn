// single source of site identity for all SEO surfaces (root metadata, robots,
// sitemap, manifest, OG images, landing JSON-LD). Reads BETTER_AUTH_URL
// directly instead of lib/subscription's baseUrl so the metadata route
// bundles never pull in auth/db/Stripe.
export const SITE_NAME = "Saturn";
export const SITE_TAGLINE = "No-code workflows for everything.";
export const SITE_TITLE = "Saturn: No-code workflows for everything";
export const SITE_DESCRIPTION =
    "Saturn is an open-source, no-code workflow builder. Wire agents, MCP tools, " +
    "Discord and Telegram bots, sandboxes, and memory on one canvas with 300+ models.";
export const GITHUB_URL = "https://github.com/Wilcus-Industries/saturn";
export const ORG_NAME = "Wilcus Industries";

export const siteUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
