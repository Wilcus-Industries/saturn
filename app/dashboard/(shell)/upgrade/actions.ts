"use server";

import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
    baseUrl,
    getActivation,
    getActivationDetails,
    isPaidPlan,
    requireUser,
} from "@/lib/subscription";

// actions are public POST endpoints — every one re-checks the session itself

export async function changePlan(plan: string) {
    if (!isPaidPlan(plan)) throw new Error("Unknown plan");
    const { requestHeaders } = await requireUser();
    const level = await getActivation(requestHeaders);
    // any activated user may move to a paid plan they're not already on
    // (upgrade or downgrade, both via the billing portal's update flow for
    // existing subscribers); also blocks a replayed POST opening a duplicate flow
    if (!level || level === plan) redirect("/dashboard/upgrade");

    const { url } = await auth.api.upgradeSubscription({
        body: {
            plan,
            // checkout (new subscriber) uses successUrl/cancelUrl; the billing
            // portal (existing subscriber changing plans) uses returnUrl
            successUrl: `${baseUrl}/dashboard/settings`,
            cancelUrl: `${baseUrl}/dashboard/upgrade`,
            returnUrl: `${baseUrl}/dashboard/settings`,
        },
        headers: requestHeaders,
    });
    if (!url) throw new Error("Stripe checkout could not be created");
    redirect(url);
}

// undo a pending cancellation: clears Stripe's cancel_at / cancel_at_period_end
// directly (no portal round-trip) and the subscription keeps renewing
export async function continueSubscription() {
    const { requestHeaders } = await requireUser();

    const { pendingCancel } = await getActivationDetails(requestHeaders);
    // restoreSubscription throws unless a cancel is pending; also blocks a
    // replayed POST after the cancellation was already undone
    if (!pendingCancel) redirect("/dashboard/upgrade");

    await auth.api.restoreSubscription({ body: {}, headers: requestHeaders });
    redirect("/dashboard/upgrade");
}

export async function downgradeToFree() {
    const { requestHeaders, session } = await requireUser();

    const { level, pendingCancel } = await getActivationDetails(requestHeaders);
    if (level !== "pro" && level !== "max") redirect("/dashboard/upgrade");

    // record the free fallback first: harmless while the sub is live (a live
    // subscription outranks the plan column) and guarantees the user lands on
    // free instead of un-activated once the subscription expires
    await db.query(`update "user" set plan = 'free' where id = $1`, [session.user.id]);

    // Stripe rejects a second cancellation while one is pending; nothing left
    // to do but record the free fallback above
    if (pendingCancel) redirect("/dashboard/upgrade");

    // Stripe Billing Portal session scoped to the cancel flow
    const { url } = await auth.api.cancelSubscription({
        body: { returnUrl: `${baseUrl}/dashboard/settings` },
        headers: requestHeaders,
    });
    redirect(url);
}
