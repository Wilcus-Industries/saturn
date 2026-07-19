import type { NextConfig } from "next";

// Defense-in-depth security headers. No known XSS sink today (React escapes,
// the only dangerouslySetInnerHTML is static JSON-LD), so the CSP is a safety
// net — and frame-ancestors/XFO are what keep the OAuth consent + authorize
// pages from being framed for click-through (ties into the MCP consent flow).
//   - script/style 'unsafe-inline': Next injects inline bootstrap scripts and
//     the designer sets many inline style attributes; no nonce pipeline here.
//   - img: 'self' + data: (console data-URL images, avatars) + Google s2
//     favicons (MCP/model logos) + the Google avatar host. s2/favicons now
//     301-redirects to t*.gstatic.com/faviconV2, so gstatic must be allowed
//     too or the redirected image load is CSP-blocked (silent broken logos).
//   - connect 'self': the OpenRouter/model calls are all server-side; the
//     browser only talks to our own origin.
// Dev needs looser script/connect rules (React Fast Refresh evals modules, HMR
// opens a websocket); computed inside headers() so NODE_ENV is resolved when
// Next bakes the rules, not at module load (when it can still be undefined).
function securityHeaders() {
    const isDev = process.env.NODE_ENV !== "production";
    const csp = [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "img-src 'self' data: https://www.google.com https://*.gstatic.com https://*.googleusercontent.com",
        "font-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
        `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
    ].join("; ");

    return [
        { key: "Content-Security-Policy", value: csp },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
        },
    ];
}

const nextConfig: NextConfig = {
    // the in-process Discord gateway (lib/gateway.server.ts) imports `ws`,
    // which is not in Next's default server-external list — keep it resolved
    // from node_modules at runtime instead of bundled (optional native peers)
    serverExternalPackages: ["ws"],
    experimental: {
        viewTransition: true,
    },
    async headers() {
        return [{ source: "/:path*", headers: securityHeaders() }];
    },
};

export default nextConfig;
