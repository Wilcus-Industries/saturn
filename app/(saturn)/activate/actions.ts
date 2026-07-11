"use server";

import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { baseUrl, getActivation, isPaidPlan, requireUser } from "@/lib/subscription";

// actions are public POST endpoints — every one re-checks the session itself

export async function activateFree() {
    const { session } = await requireUser();

    await db.query(`update "user" set plan = 'free' where id = $1`, [session.user.id]);
    redirect("/dashboard");
}

export async function activatePlan(plan: string) {
    if (!isPaidPlan(plan)) throw new Error("Unknown plan");
    const { requestHeaders } = await requireUser();

    // existing subscribers manage plans at /dashboard/upgrade; also keeps a
    // replayed POST from opening a stray portal flow (upgradeSubscription routes
    // existing subscribers to the billing portal, and this page never passes returnUrl)
    const level = await getActivation(requestHeaders);
    if (level === "pro" || level === "max") redirect("/dashboard/upgrade");

    const { url } = await auth.api.upgradeSubscription({
        body: {
            plan,
            // landing on /dashboard (vs /dashboard/settings from the upgrade
            // page) is intentional post-onboarding
            successUrl: `${baseUrl}/dashboard`,
            cancelUrl: `${baseUrl}/activate`,
        },
        headers: requestHeaders,
    });
    if (!url) throw new Error("Stripe checkout could not be created");
    redirect(url);
}
