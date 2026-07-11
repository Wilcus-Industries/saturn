import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

// lives outside the (saturn) route group on purpose — no planetary scene here.
// gated on session only, not activation level — Stripe redirects here right
// after checkout, often before the webhook has written the subscription row
export default async function Dashboard() {
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });
    if (!session?.user) redirect("/onboard");

    return <h1 className={"font-mono text-3xl"}>Overview</h1>;
}
