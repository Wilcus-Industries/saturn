import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SITE_NAME, SITE_TAGLINE } from "@/lib/seo";

export const alt = `${SITE_NAME}: ${SITE_TAGLINE}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// monochrome rendition of the landing aesthetic: near-black field, mono
// wordmark, edge-on ring divider (same glyph run as the landing section
// divider). Statically generated at build time.
export default async function Image() {
    const geistMono = await readFile(
        join(process.cwd(), "node_modules/geist/dist/fonts/geist-mono/GeistMono-Regular.ttf"),
    );

    return new ImageResponse(
        (
            <div
                style={{
                    width: "100%",
                    height: "100%",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    justifyContent: "center",
                    padding: 80,
                    background: "#0a0a0a",
                    color: "#ededed",
                    fontFamily: "Geist Mono",
                }}
            >
                <div style={{ fontSize: 96 }}>Saturn</div>
                <div style={{ fontSize: 34, color: "#a1a1aa", marginTop: 24 }}>
                    {SITE_TAGLINE}
                </div>
                <div style={{ fontSize: 24, color: "rgba(161, 161, 170, 0.4)", marginTop: 48 }}>
                    {/* the landing divider's ≡/≣ glyphs are missing from
                        Geist Mono and render as tofu in satori, so this run
                        keeps only the glyphs the font actually has */}
                    {"═".repeat(40) + "▓▓▒▒░░··"}
                </div>
            </div>
        ),
        {
            ...size,
            fonts: [{ name: "Geist Mono", data: geistMono, style: "normal", weight: 400 }],
        },
    );
}
