import MobileNav from "../mobileNav";
import Sidebar from "../sidebar";

// shell only. The sidebar's collapsed width used to come from a cookie read
// here; static export has no request, so it comes from the <head> script in
// app/layout.tsx and pure CSS instead.
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
    return (
        // the shell fills the window and clips: the document itself never
        // scrolls, so the WebView has nothing to rubber-band. Scrolling lives
        // in <main> alone, which keeps the rail pinned by construction.
        // border-t is the seam against the native titlebar, which sits directly
        // on top of the content with nothing between it and the window chrome.
        <div className={"flex h-dvh flex-col overflow-hidden border-t border-foreground/15 md:flex-row"}>
            <MobileNav />
            <Sidebar />
            <main className={"min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 md:p-8"}>
                {/* content column reflows with the window, capped for readability */}
                <div className={"mx-auto w-full max-w-5xl"}>{children}</div>
            </main>
        </div>
    );
}
