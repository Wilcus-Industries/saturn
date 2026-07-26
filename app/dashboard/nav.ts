import { Comments, Database, DiagramProject, Gear, Robot } from "./icons";

// the sidebar's destinations.
// Hrefs carry a trailing slash to match `trailingSlash: true`: every route is
// exported as `<dir>/index.html`, and Tauri's asset protocol does no
// extensionless fallback, so a reload at a slash-less path finds no file.
export const NAV = [
    // /dashboard/agent/, not /dashboard/: isActive matches on a segment boundary,
    // so a base of "/dashboard" would light this tab on every page in the shell.
    { label: "Agent", href: "/dashboard/agent/", icon: Robot },
    { label: "Sessions", href: "/dashboard/sessions/", icon: Comments },
    { label: "Workflows", href: "/dashboard/workflows/", icon: DiagramProject },
    { label: "Memory", href: "/dashboard/memory/", icon: Database },
    { label: "Settings", href: "/dashboard/settings/", icon: Gear },
];

// Normalizes both sides, because `usePathname()` reports what is actually in
// the address bar and that is slash-terminated on a hard load but whatever the
// pushed href was after a client navigation. Segment-boundary match, so
// /dashboard/memory does not light up for a hypothetical /dashboard/memories.
const trim = (path: string) => path.replace(/\/+$/, "");

export function isActive(pathname: string, { href }: { href: string }) {
    const base = trim(href);
    const here = trim(pathname);
    return here === base || here.startsWith(`${base}/`);
}
