import MobileNav from "../mobileNav";
import Sidebar from "../sidebar";

// shell only. The sidebar's collapsed width used to come from a cookie read
// here; static export has no request, so it comes from the <head> script in
// app/layout.tsx and pure CSS instead.
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
    return (
        <div className={"flex min-h-dvh flex-col md:flex-row"}>
            <MobileNav />
            <Sidebar />
            <main className={"min-w-0 flex-1 p-4 md:p-8"}>
                {/* content column reflows with the window, capped for readability */}
                <div className={"mx-auto w-full max-w-5xl"}>{children}</div>
            </main>
        </div>
    );
}
