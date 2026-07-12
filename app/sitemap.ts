import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/seo";

// only the landing page is indexable — /onboard and /activate are noindexed
// (sitemaps must not list noindexed URLs) and everything else is auth-gated
export default function sitemap(): MetadataRoute.Sitemap {
    return [
        {
            url: siteUrl,
            lastModified: new Date(),
            changeFrequency: "weekly",
            priority: 1,
        },
    ];
}
