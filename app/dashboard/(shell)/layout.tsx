"use client";

import { usePathname } from "next/navigation";
import { isActive } from "../nav";
import TopBar from "../topBar";
import DesignerHost from "./workflows/designer/host";

// the designer's route, as `isActive` wants it — a nav item shape, so the same
// segment-boundary match the top bar's chips use decides this too
const DESIGNER = { href: "/dashboard/workflows/designer/" };

// shell only. One top bar across the window and a capped content column under
// it — there is no sidebar rail and no collapse preference to restore, so this
// layout reads no storage and stamps nothing on <html>.
//
// **It also owns the designer**, which is the one thing here that is not
// layout. A route is unmounted on every navigation, and the designer's undo
// history, canvas viewport, selection, console and agent panel width live
// nowhere but that subtree — so the designer is mounted HERE, where a layout
// survives its children changing, and the route under it
// (`workflows/designer/page.tsx`) is reduced to writing `?id=` into
// `openStore`. Switching tabs swaps which of the two siblings below is
// display:none; nothing is torn down. `openStore.ts` carries the full argument.
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
    const onDesigner = isActive(usePathname(), DESIGNER);

    return (
        // the shell fills the window and clips: the document itself never
        // scrolls, so the WebView has nothing to rubber-band. Scrolling lives
        // in <main> alone, which keeps the bar pinned by construction.
        // border-t is the seam against the native titlebar, which sits directly
        // on top of the content with nothing between it and the window chrome.
        <div className={"flex h-dvh flex-col overflow-hidden border-t border-foreground/15"}>
            <TopBar />
            {/* overflow-x-hidden is what lets a child break out of the content
                column to the window's full width (the agent page's chat tabs):
                the part of it that hangs past this padding box would otherwise
                be a horizontal scrollbar */}
            <main
                className={
                    "min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto " +
                    "overscroll-contain p-8" +
                    // hidden, not unrendered: the designer's own route still
                    // mounts under here to register its id
                    (onDesigner ? " hidden" : "")
                }
            >
                {/* content column reflows with the window, capped for readability */}
                <div className={"mx-auto w-full max-w-5xl"}>{children}</div>
            </main>
            {/* the designer takes <main>'s slot rather than sitting inside it:
                a canvas wants the whole window, not a padded max-w-5xl column */}
            <DesignerHost hidden={!onDesigner} />
        </div>
    );
}
