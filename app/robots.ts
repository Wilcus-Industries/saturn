import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/seo";

// /onboard and /activate are deliberately NOT disallowed here — they carry a
// meta noindex, which crawlers can only honor if allowed to fetch the page.
// /.well-known stays crawlable (OAuth discovery documents).
export default function robots(): MetadataRoute.Robots {
    return {
        rules: {
            userAgent: "*",
            allow: "/",
            disallow: ["/dashboard", "/dashboard/", "/api/", "/mcp"],
        },
        sitemap: `${siteUrl}/sitemap.xml`,
    };
}
