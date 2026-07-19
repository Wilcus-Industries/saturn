"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FaAnglesLeft, FaAnglesRight } from "react-icons/fa6";
import AsciiSaturn from "@/app/(saturn)/asciiSaturn";
import { NAV, isActive } from "./nav";
import NavIcon from "./navIcon";

export default function Sidebar({ initialCollapsed }: { initialCollapsed: boolean }) {
    const [collapsed, setCollapsed] = useState(initialCollapsed);
    const pathname = usePathname();

    function toggle() {
        const next = !collapsed;
        setCollapsed(next);
        // UI preference only — read by the layout so the first paint has the right width
        document.cookie = `sidebar=${next ? "collapsed" : "open"}; path=/; max-age=31536000`;
    }

    return (
        <aside
            className={`sticky top-0 hidden h-dvh shrink-0 flex-col overflow-hidden border-r border-foreground/15 md:flex
                bg-background transition-[width] duration-200 ease-out motion-reduce:transition-none
                ${collapsed ? "w-16" : "w-64"}`}
        >
            {/* lockup — the landing hero's saturn, downsampled to a sidebar mark.
                everything is left-anchored so nothing shifts while the width animates:
                the mark sits at the collapsed rail's center and the label just fades
                out while the shrinking rail clips it */}
            <Link
                href={"/dashboard"}
                aria-label={"Saturn dashboard"}
                className={"flex h-16 shrink-0 items-center gap-2 pl-[10px]"}
            >
                <div className={"shrink-0"}>
                    <AsciiSaturn scale={4} sizeClass={"text-[3px]"} noise={false} />
                </div>
                <span
                    className={`font-mono text-2xl whitespace-nowrap transition-opacity duration-200
                        ${collapsed ? "opacity-0" : "opacity-100"}`}
                >
                    Saturn
                </span>
            </Link>

            <nav className={"flex flex-1 flex-col gap-1 px-2 pt-4"}>
                {NAV.map(item => {
                    const { label, href, icon: Icon } = item;
                    const active = isActive(pathname, item);
                    return (
                        <Link
                            key={href}
                            href={href}
                            aria-current={active ? "page" : undefined}
                            className={`flex items-center gap-3 whitespace-nowrap rounded-full
                                py-2 pl-4 pr-3 font-mono text-sm transition-colors duration-200
                                ${active
                                    ? "bg-foreground text-background"
                                    : "text-gray-400 hover:bg-foreground hover:text-background"}`}
                        >
                            <NavIcon icon={Icon} className={"h-4 w-4"} />
                            <span
                                className={`transition-opacity duration-200
                                    ${collapsed ? "opacity-0" : "opacity-100"}`}
                            >
                                {label}
                            </span>
                        </Link>
                    );
                })}
            </nav>

            <button
                type={"button"}
                onClick={toggle}
                aria-expanded={!collapsed}
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                className={`m-2 flex items-center justify-center rounded-full border border-foreground
                    bg-background p-2 transition-colors duration-200 hover:bg-foreground hover:text-background`}
            >
                {collapsed ? <FaAnglesRight className={"h-3.5 w-3.5"} /> : <FaAnglesLeft className={"h-3.5 w-3.5"} />}
            </button>
        </aside>
    );
}
