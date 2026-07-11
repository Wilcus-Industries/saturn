"use client";

import { ViewTransition } from "react";

// wraps a page's foreground content: forward navs lift it up and away, back
// navs sink it down — classes are animated in globals.css. The Links set the
// matching transitionTypes; untyped navigations (e.g. browser back) swap
// instantly via default="none".
export default function PageTransition({ children }: { children: React.ReactNode }) {
    return (
        <ViewTransition
            enter={{ "nav-forward": "vt-page-enter-forward", "nav-back": "vt-page-enter-back", default: "none" }}
            exit={{ "nav-forward": "vt-page-exit-forward", "nav-back": "vt-page-exit-back", default: "none" }}
            default={"none"}
        >
            {children}
        </ViewTransition>
    );
}
