import type { NextConfig } from "next";

// Static export: the whole UI is prerendered to plain files under `out/` that
// Tauri serves over its asset protocol (tauri.conf.json `frontendDist`). There
// is no Node server at runtime, which is why every server-only affordance below
// is gone:
//
//   - `headers()`. Security headers are an HTTP-response concept and nothing
//     serves HTTP anymore. The CSP moves to tauri.conf.json's `app.security.csp`,
//     which is the only layer that still sees a request. `frame-ancestors` and
//     HSTS have no meaning inside a WebView with no navigation surface.
//   - `serverExternalPackages`. `ws` was for the in-process Discord gateway;
//     that loop is Rust now (src-tauri/src/gateway.rs).
//
// Static export also forbids dynamic route segments that aren't enumerable at
// build time, so /dashboard/workflows/[id] became /dashboard/workflows/designer
// with the id in a query string. See docs/open-decisions.md.
//
// `distDir` stays at its default. Pointing it straight at the directory Tauri
// embeds looks tidier but only `next build` remaps distDir→export output
// (export/utils.ts `hasCustomExportOutput`); `next dev` uses it verbatim, so
// `tauri dev` would spray the dev bundler's cache/, server/ and trace over the
// embedded frontend — inside the tree tauri dev watches for Rust rebuilds.
const nextConfig: NextConfig = {
    output: "export",
    // Every route emits as a directory with an index.html, so every href in the
    // app names a file that exists. Tauri's resolver would cope either way — it
    // falls back `path` → `path.html` → `path/index.html` (tauri's
    // `AppManager::get_asset`) — but matching the layout exactly means a broken
    // link fails as a broken link instead of quietly resolving one level over.
    trailingSlash: true,
};

export default nextConfig;
