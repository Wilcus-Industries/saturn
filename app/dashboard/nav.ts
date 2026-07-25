import { FaDatabase, FaDiagramProject, FaGear, FaWandMagicSparkles } from "react-icons/fa6";

// shared between the desktop sidebar and the mobile top bar
export const NAV = [
    { label: "Agent", href: "/dashboard", icon: FaWandMagicSparkles, exact: true },
    { label: "Workflows", href: "/dashboard/workflows", icon: FaDiagramProject },
    { label: "Memory", href: "/dashboard/memory", icon: FaDatabase },
    { label: "Settings", href: "/dashboard/settings", icon: FaGear },
];

export function isActive(pathname: string, { href, exact }: { href: string; exact?: boolean }) {
    return exact ? pathname === href : pathname.startsWith(href);
}
