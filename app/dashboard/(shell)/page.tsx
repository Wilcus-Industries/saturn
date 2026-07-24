import { redirect } from "next/navigation";
import AsciiSaturn from "@/app/(saturn)/asciiSaturn";
import { listOpenrouterModels } from "@/lib/openrouter.server";
import { getSessionCached } from "@/lib/subscription";
import AgentComposer from "./agentComposer";

// lives outside the (saturn) route group on purpose — no planetary scene here.
// gated on session only, not activation level — Stripe redirects here right
// after checkout, often before the webhook has written the subscription row
export default async function Dashboard() {
    const session = await getSessionCached();
    if (!session?.user) redirect("/onboard");

    // public 1h-cached list feeding the composer's model selector (visual-only
    // for now; [] on fetch failure — composer falls back to a canned list)
    const models = await listOpenrouterModels();

    // fill the viewport from inside the shell padding: mobile = two-row top bar
    // (h-12 lockup + chip row ≈ 87px) + p-4 ≈ 119px, 7.5rem leaves 1px slack;
    // desktop = p-8 (4rem). min-h, not h — short viewports scroll.
    return (
        <div className={"flex min-h-[calc(100dvh-7.5rem)] flex-col md:min-h-[calc(100dvh-4rem)]"}>
            <div
                className={
                    "agent-enter -mt-4 flex flex-1 flex-col items-center justify-center gap-8 md:-mt-8"
                }
            >
                <AsciiSaturn scale={2} sizeClass={"text-[min(9px,2vw)]"} noise={false} />
                <div className={"flex flex-col items-center gap-2 text-center"}>
                    <h1 className={"font-mono text-2xl md:text-3xl"}>Say hello to Saturn Agent</h1>
                    <p className={"font-mono text-sm text-gray-400"}>
                        Ask about your workflows, runs, and memory — or just say hi.
                    </p>
                </div>
            </div>
            <AgentComposer models={models} />
        </div>
    );
}
