import { redirect } from "next/navigation";
import { listOpenrouterModels } from "@/lib/openrouter.server";
import { getSessionCached } from "@/lib/subscription";
import AgentChat from "./agentChat";

// Saturn Agent — a streaming back-and-forth chat. Lives outside the (saturn)
// route group on purpose (no planetary scene). Gated on session only, not
// activation: Stripe redirects here right after checkout, often before the
// webhook has written the subscription row.
export default async function Dashboard() {
    const session = await getSessionCached();
    if (!session?.user) redirect("/onboard");

    // public 1h-cached list feeding the composer's model selector. [] on fetch
    // failure — the composer falls back to a canned list. The chat endpoint
    // enforces funding (credits/BYOK), so the list stays ungated for now.
    const models = await listOpenrouterModels();

    return <AgentChat models={models} />;
}
