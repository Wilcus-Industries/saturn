"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import AsciiSaturn from "@/app/dashboard/asciiSaturn";
import { NAV, isActive } from "./nav";
import NavIcon from "./navIcon";

// The shell's only navigation: one 3rem bar across the top of the window, mark
// then chips. Descended from the hosted product's phone top bar (`mobileNav.tsx`,
// dropped in c88d578 and restored here) with the width gate removed, because a
// desktop window has room for the chips beside the mark and this reads better
// than the rail it replaced — a 16rem sidebar spent a sixth of the window on five
// links. There is no collapsed state to remember, so no <head> script and no
// `data-sidebar` attribute either.
//
// **h-12 is a contract.** The agent page sizes its column off the viewport and
// subtracts this bar, so the height is a flat number here rather than something
// that grows to fit its content; change it and change
// `(shell)/agent/page.tsx`'s calc with it.
export default function TopBar() {
    const pathname = usePathname();

    return (
        <header
            className={
                "sticky top-0 z-10 flex h-12 shrink-0 items-center gap-4 border-b " +
                "border-foreground/15 bg-background px-4"
            }
        >
            {/* the mark alone — the wordmark it used to sit beside is gone, and
                aria-label was already carrying the accessible name */}
            <Link
                href={"/dashboard/agent/"}
                aria-label={"Saturn agent"}
                className={"flex shrink-0 items-center"}
            >
                <AsciiSaturn scale={4} />
            </Link>

            {/* chips keep one fixed size at every viewport width; the row
                scrolls horizontally whenever they don't all fit, which is what
                min-w-0 buys — without it the row shoves the mark instead */}
            <nav
                className={`flex min-w-0 gap-1.5 overflow-x-auto
                    [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`}
            >
                {NAV.map((item) => {
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
                                ${
                                    active
                                        ? "border-foreground bg-foreground text-background"
                                        : "text-gray-400 hover:bg-foreground hover:text-background"
                                }`}
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
