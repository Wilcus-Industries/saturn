import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getActivationDetails, LEVEL_RANK } from "@/lib/subscription";
import TierCard, { TIER_BUTTON, type Tier } from "@/app/(saturn)/activate/tierCard";
import { changePlan, continueSubscription, downgradeToFree } from "./actions";
import ActionButton from "../../actionButton";

const TIER_ORDER = ["free", "pro", "max"] as const satisfies readonly Tier[];

export default async function Upgrade() {
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });
    if (!session?.user) redirect("/onboard");

    const { level, pendingCancel, periodEnd } = await getActivationDetails(requestHeaders);
    // first activation belongs to onboarding
    if (!level) redirect("/activate");

    const rank = LEVEL_RANK[level];

    const currentLabel = (
        <p className={"p-2 text-center font-mono text-sm border border-dashed border-current"}>
            your current subscription
        </p>
    );

    return (
        <div className={"flex flex-col gap-6"}>
            <h1 className={"font-mono text-3xl"}>Upgrade</h1>
            <p className={"font-sans"}>
                All payments are processed via Stripe, and can be cancelled at any time.
            </p>
            <div className={"flex flex-wrap gap-3"}>
                {TIER_ORDER.map((tier) => {
                    // free has no card action — leaving a paid plan is the
                    // current card's Cancel subscription button
                    const direction =
                        LEVEL_RANK[tier] > rank
                            ? "Upgrade"
                            : LEVEL_RANK[tier] < rank && tier !== "free"
                              ? "Downgrade"
                              : null;
                    return (
                        <TierCard key={tier} tier={tier} interactive={direction !== null}>
                            {tier === level && (
                                <div className={"mt-auto flex flex-col gap-2"}>
                                    {currentLabel}
                                    {level !== "free" &&
                                        (pendingCancel ? (
                                            <>
                                                <p className={"p-2 text-center font-mono text-sm"}>
                                                    cancels{" "}
                                                    {periodEnd
                                                        ? periodEnd.toLocaleDateString("en-US", {
                                                              month: "long",
                                                              day: "numeric",
                                                              year: "numeric",
                                                          })
                                                        : "at period end"}
                                                </p>
                                                <form action={continueSubscription}>
                                                    <ActionButton className={TIER_BUTTON[tier]}>
                                                        Continue subscription
                                                    </ActionButton>
                                                </form>
                                            </>
                                        ) : (
                                            <form action={downgradeToFree}>
                                                <ActionButton className={TIER_BUTTON[tier]}>
                                                    Cancel subscription
                                                </ActionButton>
                                            </form>
                                        ))}
                                </div>
                            )}
                            {direction && (
                                <form action={changePlan.bind(null, tier)} className={"mt-auto"}>
                                    <ActionButton className={TIER_BUTTON[tier]}>
                                        {direction}
                                    </ActionButton>
                                </form>
                            )}
                        </TierCard>
                    );
                })}
            </div>
        </div>
    );
}
