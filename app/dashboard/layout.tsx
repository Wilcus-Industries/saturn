import type { Metadata } from "next";

// metadata-only pass-through: marks every /dashboard route noindex in one
// place — covers the (shell) group and the shell-less designer at
// /dashboard/workflows/[id] without touching their markup
export const metadata: Metadata = {
    title: "Dashboard",
    robots: { index: false, follow: false },
};

export default function DashboardRoot({
    children,
}: {
    children: React.ReactNode;
}) {
    return children;
}
