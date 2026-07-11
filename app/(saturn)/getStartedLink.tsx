"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

// resolves once the window has smooth-scrolled back to the top; the scroll
// listener beats "scrollend" (no Safari support) and the timeout covers
// interrupted scrolls so navigation can never get stuck waiting
function scrollToTop(): Promise<void> {
    return new Promise((resolve) => {
        if (window.scrollY === 0) {
            resolve();
            return;
        }
        let stallTimer: number;
        const finish = () => {
            window.clearTimeout(stallTimer);
            window.removeEventListener("scroll", onScroll);
            resolve();
        };
        const onScroll = () => {
            if (window.scrollY === 0) {
                finish();
            } else {
                window.clearTimeout(stallTimer);
                stallTimer = window.setTimeout(finish, 250);
            }
        };
        window.addEventListener("scroll", onScroll, { passive: true });
        stallTimer = window.setTimeout(finish, 250);
        window.scrollTo({ top: 0, behavior: "smooth" });
    });
}

// "Get Started" keeps Link semantics (prefetch, middle-click, copy address)
// but when the page is scrolled it glides back to the top before running the
// forward view-transition, so the exit animation plays from the hero screen
export default function GetStartedLink({ className, children }: {
    className?: string;
    children: React.ReactNode;
}) {
    const router = useRouter();

    function onClick(e: React.MouseEvent<HTMLAnchorElement>) {
        if (window.scrollY === 0) return; // let Link navigate as usual
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        scrollToTop().then(() => router.push("/onboard", { transitionTypes: ["nav-forward"] }));
    }

    return (
        <Link className={className} href={"/onboard"} transitionTypes={["nav-forward"]} onClick={onClick}>
            {children}
        </Link>
    );
}
