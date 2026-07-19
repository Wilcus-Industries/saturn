import { FaDatabase, FaDiagramProject, FaGear, FaHouse } from "react-icons/fa6";

// shared between the desktop sidebar and the mobile top bar
export const NAV = [
    { label: "Overview", href: "/dashboard", icon: FaHouse, exact: true },
    { label: "Workflows", href: "/dashboard/workflows", icon: FaDiagramProject },
    { label: "Memory", href: "/dashboard/memory", icon: FaDatabase },
    { label: "Settings", href: "/dashboard/settings", icon: FaGear },
];

export function isActive(pathname: string, { href, exact }: { href: string; exact?: boolean }) {
    return exact ? pathname === href : pathname.startsWith(href);
}
