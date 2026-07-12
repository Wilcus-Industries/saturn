// single source of site identity for all SEO surfaces (root metadata, robots,
// sitemap, manifest, OG images, landing JSON-LD). Reads BETTER_AUTH_URL
// directly instead of lib/subscription's baseUrl so the metadata route
// bundles never pull in auth/db/Stripe.
export const SITE_NAME = "Saturn";
export const SITE_TAGLINE = "Agentic automations, anywhere and anytime.";
export const SITE_TITLE = "Saturn: Agentic automations, anywhere and anytime";
export const SITE_DESCRIPTION =
    "Saturn is an open-source, node-based designer for agentic automations. " +
    "Drag agents, MCP tools, skills, and cron triggers onto a canvas, wire them " +
    "together, and run them on a schedule with 300+ models via OpenRouter or your own keys.";
export const GITHUB_URL = "https://github.com/Wilcus-Industries/saturn";
export const ORG_NAME = "Wilcus Industries";

export const siteUrl =
    process.env.BETTER_AUTH_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : "http://localhost:3000");
