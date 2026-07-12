import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/seo";

// only the landing and legal pages are indexable — /onboard and /activate are
// noindexed (sitemaps must not list noindexed URLs) and everything else is
// auth-gated
export default function sitemap(): MetadataRoute.Sitemap {
    return [
        {
            url: siteUrl,
            lastModified: new Date(),
            changeFrequency: "weekly",
            priority: 1,
        },
        {
            url: `${siteUrl}/terms`,
            lastModified: new Date(),
            changeFrequency: "yearly",
            priority: 0.3,
        },
        {
            url: `${siteUrl}/privacy`,
            lastModified: new Date(),
            changeFrequency: "yearly",
            priority: 0.3,
        },
    ];
}
