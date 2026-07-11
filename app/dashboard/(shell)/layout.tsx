import { cookies } from "next/headers";
import MobileNav from "../mobileNav";
import Sidebar from "../sidebar";

// shell only — session checks live in each page, since layouts don't re-run on
// client-side navigation. the sidebar cookie makes the first paint width-correct.
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
    const collapsed = (await cookies()).get("sidebar")?.value === "collapsed";

    return (
        <div className={"flex min-h-dvh flex-col md:flex-row"}>
            <MobileNav />
            <Sidebar initialCollapsed={collapsed} />
            <main className={"min-w-0 flex-1 p-4 md:p-8"}>
                {/* content column reflows with the window, capped for readability */}
                <div className={"mx-auto w-full max-w-5xl"}>{children}</div>
            </main>
        </div>
    );
}
