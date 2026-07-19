"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import AsciiSaturn from "@/app/(saturn)/asciiSaturn";
import { NAV, isActive } from "./nav";
import NavIcon from "./navIcon";

export default function MobileNav() {
    const pathname = usePathname();

    return (
        <header className={"sticky top-0 z-10 border-b border-foreground/15 bg-background md:hidden"}>
            {/* same lockup as the sidebar, laid flat in a top bar */}
            <Link
                href={"/dashboard"}
                aria-label={"Saturn dashboard"}
                className={"flex h-12 items-center gap-2 px-4"}
            >
                <div className={"shrink-0"}>
                    <AsciiSaturn scale={4} sizeClass={"text-[3px]"} noise={false} />
                </div>
                <span className={"font-mono text-2xl"}>Saturn</span>
            </Link>

            {/* chips keep one fixed size at every viewport width; the row
                scrolls horizontally whenever they don't all fit */}
            <nav
                className={`flex gap-1.5 overflow-x-auto px-2 pb-2
                    [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`}
            >
                {NAV.map(item => {
                    const { label, href, icon: Icon } = item;
                    const active = isActive(pathname, item);
                    return (
                        <Link
                            key={href}
                            href={href}
                            aria-current={active ? "page" : undefined}
                            className={`flex shrink-0 items-center gap-1.5 rounded-full
                                border border-foreground/15 px-3 py-1.5 font-mono text-xs
                                whitespace-nowrap transition-colors duration-200
                                ${active
                                    ? "border-foreground bg-foreground text-background"
                                    : "text-gray-400 hover:bg-foreground hover:text-background"}`}
                        >
                            <NavIcon icon={Icon} className={"h-3.5 w-3.5"} />
                            {label}
                        </Link>
                    );
                })}
            </nav>
        </header>
    );
}
