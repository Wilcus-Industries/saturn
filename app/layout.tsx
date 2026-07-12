import type { Metadata, Viewport } from "next";
import {Geist, Geist_Mono, Inter} from "next/font/google";
import {GeistPixelSquare} from "geist/font/pixel";
import {Analytics} from "@vercel/analytics/next";
import {ORG_NAME, SITE_DESCRIPTION, SITE_NAME, SITE_TITLE, GITHUB_URL, siteUrl} from "@/lib/seo";
import "./globals.css";

const geistSans = Geist({
    variable: "--font-geist-sans",
    subsets: ["latin"],
});

const geistMono = Geist_Mono({
    variable: "--font-geist-mono",
    subsets: ["latin"],
});

const inter = Inter({
    variable: "--font-inter",
    subsets: ["latin"],
})

// og:image / twitter:image / icons / manifest links come from the file
// conventions (app/opengraph-image.tsx, app/twitter-image.tsx, app/icon.png,
// app/apple-icon.png, app/manifest.ts) — they override the metadata object,
// so those fields are deliberately absent here
export const metadata: Metadata = {
    metadataBase: new URL(siteUrl),
    title: {
        default: SITE_TITLE,
        template: `%s · ${SITE_NAME}`,
    },
    description: SITE_DESCRIPTION,
    applicationName: SITE_NAME,
    keywords: [
        "agentic automations",
        "AI agents",
        "workflow automation",
        "MCP",
        "Model Context Protocol",
        "node-based editor",
        "cron automation",
        "OpenRouter",
        "open source",
        "LLM workflows",
    ],
    authors: [{ name: ORG_NAME, url: GITHUB_URL }],
    creator: ORG_NAME,
    publisher: ORG_NAME,
    category: "technology",
    robots: {
        index: true,
        follow: true,
        googleBot: {
            index: true,
            follow: true,
            "max-image-preview": "large",
            "max-snippet": -1,
            "max-video-preview": -1,
        },
    },
    openGraph: {
        type: "website",
        siteName: SITE_NAME,
        locale: "en_US",
        url: "/",
        title: SITE_TITLE,
        description: SITE_DESCRIPTION,
    },
    twitter: {
        card: "summary_large_image",
        title: SITE_TITLE,
        description: SITE_DESCRIPTION,
    },
};

export const viewport: Viewport = {
    themeColor: [
        { media: "(prefers-color-scheme: light)", color: "#ffffff" },
        { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
    ],
    colorScheme: "light dark",
};

export default function RootLayout({
                                       children,
                                   }: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html
            lang="en"
            className={`${geistSans.variable} ${geistMono.variable} ${GeistPixelSquare.variable} ${inter.variable} h-full antialiased`}>
            <body className="min-h-full flex flex-col">
                {children}
                <Analytics />
            </body>
        </html>
    );
}
