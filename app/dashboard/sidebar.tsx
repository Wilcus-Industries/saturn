"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnglesLeft, AnglesRight } from "./icons";
import AsciiSaturn from "@/app/dashboard/asciiSaturn";
import { NAV, isActive } from "./nav";
import NavIcon from "./navIcon";

// The collapse state lives on <html data-sidebar>, not in React. The <head>
// script in app/layout.tsx stamps it from localStorage before the first paint
// and globals.css does the width, which is what keeps the old cookie's job done
// without a server. That makes the attribute an external store: React only
// reads it, for the toggle's icon and aria-expanded (neither shifts layout, so
// the pre-hydration frame is harmless).
const subscribe = (onChange: () => void) => {
    const observer = new MutationObserver(onChange);
    observer.observe(document.documentElement, { attributeFilter: ["data-sidebar"] });
    return () => observer.disconnect();
};
const isCollapsed = () => document.documentElement.dataset.sidebar === "collapsed";

export default function Sidebar() {
    const collapsed = useSyncExternalStore(subscribe, isCollapsed, () => false);
    const pathname = usePathname();

    function toggle() {
        const value = collapsed ? "open" : "collapsed";
        document.documentElement.dataset.sidebar = value;
        try {
            localStorage.sidebar = value;
        } catch {
            // storage blocked — the preference just won't survive a reload
        }
    }

    return (
        <aside
            data-sidebar-rail
            className={`sticky top-0 flex h-dvh w-64 shrink-0 flex-col overflow-hidden border-r border-foreground/15
                bg-background transition-[width] duration-200 ease-out motion-reduce:transition-none`}
        >
            {/* lockup — the landing hero's saturn, downsampled to a sidebar mark.
                everything is left-anchored so nothing shifts while the width animates:
                the mark sits at the collapsed rail's center and the label just fades
                out while the shrinking rail clips it */}
            <Link
                href={"/dashboard/workflows/"}
                aria-label={"Saturn workflows"}
                className={"flex h-16 shrink-0 items-center gap-2 pl-[10px]"}
            >
                <div className={"shrink-0"}>
                    <AsciiSaturn scale={4} />
                </div>
                <span
                    data-sidebar-label
                    className={`font-mono text-2xl whitespace-nowrap opacity-100 transition-opacity duration-200`}
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
                                data-sidebar-label
                                className={"opacity-100 transition-opacity duration-200"}
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
                {collapsed ? <AnglesRight className={"h-3.5 w-3.5"} /> : <AnglesLeft className={"h-3.5 w-3.5"} />}
            </button>
        </aside>
    );
}
