import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { getActivation } from "@/lib/subscription";
import PageTransition from "../pageTransition";
import TierCard, { TIER_BUTTON } from "./tierCard";
import { activateFree, activatePlan } from "./actions";

export const metadata: Metadata = {
    title: "Activate",
    robots: { index: false, follow: false },
};

// activation is post-auth — reachable only with a live session, otherwise send
// the user back to connect an account first; already-activated users go
// straight to the dashboard (plan changes live at /dashboard/upgrade)
export default async function Activate() {
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });
    if (!session?.user) redirect("/onboard");
    if (await getActivation(requestHeaders)) redirect("/dashboard");

    return (
        <PageTransition>
            <div className={"absolute top-5 left-5 right-5 z-10 pl-3 flex flex-col gap-3"}>
                <h1 className={"text-5xl font-mono"}>Activate</h1>
                <p className={"w-full max-w-100 font-sans"}>
                    Welcome <b>{session?.user.name}</b>,
                </p>
                <p className={"w-full max-w-100 font-sans"}>
                    Bring your own keys or subscribe for premium Saturn access.
                </p>
                <p className={"w-full max-w-100 font-sans"}>
                    All payments are processed via Stripe, and can be cancelled at any time.
                </p>
                <div className={"flex flex-wrap gap-3"}>
                    <TierCard tier={"free"}>
                        <form action={activateFree} className={"mt-auto"}>
                            <button className={TIER_BUTTON.free} type={"submit"}>
                                Continue
                            </button>
                        </form>
                    </TierCard>
                    <TierCard tier={"pro"}>
                        <form action={activatePlan.bind(null, "pro")} className={"mt-auto"}>
                            <button className={TIER_BUTTON.pro} type={"submit"}>
                                Activate
                            </button>
                        </form>
                    </TierCard>
                    <TierCard tier={"max"}>
                        <form action={activatePlan.bind(null, "max")} className={"mt-auto"}>
                            <button className={TIER_BUTTON.max} type={"submit"}>
                                Activate
                            </button>
                        </form>
                    </TierCard>
                </div>
                <Link href={"/"} transitionTypes={["nav-back"]} className={"text-blue-400 font-sans"}>
                    Back
                </Link>
            </div>
        </PageTransition>
    );
}
