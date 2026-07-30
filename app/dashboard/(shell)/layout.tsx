import TopBar from "../topBar";

// shell only. One top bar across the window and a capped content column under
// it — there is no sidebar rail and no collapse preference to restore, so this
// layout reads no storage and stamps nothing on <html>.
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
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
                    "overscroll-contain p-8"
                }
            >
                {/* content column reflows with the window, capped for readability */}
                <div className={"mx-auto w-full max-w-5xl"}>{children}</div>
            </main>
        </div>
    );
}
