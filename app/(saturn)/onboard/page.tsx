import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SELF_HOSTED } from "@/lib/selfhost";
import { getActivation, getSessionCached } from "@/lib/subscription";
import Connect from "./connect";

export const metadata: Metadata = {
    title: "Get started",
    description: "Connect your Google account to start building agentic automations with Saturn.",
    robots: { index: false, follow: true },
};

// signed-in users skip the connect step entirely — the redirect runs during
// this server render, so the connect UI is never sent to the client; users
// with a saved activation level skip activation too
export default async function Onboard() {
    // self-hosted: no sign-in step — the synthetic owner is always present
    if (SELF_HOSTED) redirect("/dashboard");
    const requestHeaders = await headers();
    const session = await getSessionCached();
    if (session?.user) {
        redirect((await getActivation(requestHeaders)) ? "/dashboard" : "/activate");
    }
    return <Connect />;
}
