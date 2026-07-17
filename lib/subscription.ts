import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export type ActivationLevel = "max" | "pro" | "free";

export type Activation = {
    level: ActivationLevel | null;
    status: "active" | "trialing" | null; // null for free / no plan
    pendingCancel: boolean;
    periodEnd: Date | null; // when a pending cancellation takes effect
};

export const LEVEL_RANK = { free: 0, pro: 1, max: 2 } as const satisfies Record<ActivationLevel, number>;

export const PAID_PLANS = ["pro", "max"] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];
export const isPaidPlan = (p: string): p is PaidPlan =>
    (PAID_PLANS as readonly string[]).includes(p);

export const baseUrl = process.env.BETTER_AUTH_URL as string;

// per-tier platform limits — the value metric paid tiers charge for. Workflow/
// MCP caps are enforced in server actions (createWorkflow, saveMcpServer);
// tierCard.tsx copy must stay in sync with these numbers. cronFloorMinutes is
// the tightest cron schedule a tier may run (free hourly, pro every 5 min, max
// every minute) — enforced by the designer's cron picker cap and the runner's
// run-time claim-guard clamp (lib/runner.server.ts), not at metadata save.
// modelCredits is the built-in model allowance (1,000 credits = $1 of model
// cost; spent via lib/credits.server.ts) — per Stripe billing period on paid
// tiers, rolling 30-day window on free. Only an explicitly activated level
// gets it: getCreditUsage zeroes the allowance for level=null, unlike the
// other limits (limitsFor treats null as free).
export const PLAN_LIMITS = {
    free: { workflows: 3, mcpServers: 3, cronFloorMinutes: 60, modelCredits: 1_000 },
    pro: { workflows: 20, mcpServers: 10, cronFloorMinutes: 5, modelCredits: 15_000 },
    max: { workflows: 100, mcpServers: 50, cronFloorMinutes: 1, modelCredits: 60_000 },
} as const satisfies Record<
    ActivationLevel,
    { workflows: number; mcpServers: number; cronFloorMinutes: number; modelCredits: number }
>;

// not-yet-activated users get free limits
export const limitsFor = (level: ActivationLevel | null) => PLAN_LIMITS[level ?? "free"];

const NONE: Activation = { level: null, status: null, pendingCancel: false, periodEnd: null };

// effective activation for the current request: an active/trialing Stripe
// subscription wins (max over pro), then the self-serve free tier, then nothing
export async function getActivationDetails(headers: Headers): Promise<Activation> {
    const session = await auth.api.getSession({ headers });
    if (!session?.user) return NONE;

    const subscriptions = await auth.api.listActiveSubscriptions({ headers });
    const live = subscriptions.filter(
        (s) => s.status === "active" || s.status === "trialing",
    );
    // status must come from the same subscription that decides the level
    for (const plan of ["max", "pro"] as const) {
        const sub = live.find((s) => s.plan === plan);
        if (sub) {
            // Stripe records a portal cancellation as a cancelAt timestamp; the
            // cancelAtPeriodEnd flag stays false, so check both
            const cancelAt = sub.cancelAt ? new Date(sub.cancelAt) : null;
            const pendingCancel = (sub.cancelAtPeriodEnd ?? false) || cancelAt !== null;
            return {
                level: plan,
                status: sub.status as "active" | "trialing",
                pendingCancel,
                periodEnd: cancelAt ?? (sub.periodEnd ? new Date(sub.periodEnd) : null),
            };
        }
    }

    if (session.user.plan === "free") return { ...NONE, level: "free" };
    return NONE;
}

export async function getActivation(headers: Headers): Promise<ActivationLevel | null> {
    return (await getActivationDetails(headers)).level;
}

// headless tier resolution for the cron runner, which has no request (and so no
// headers for getActivation) — queries better-auth's subscription table and
// user.plan directly. Mirrors getActivationDetails semantics: an active/trialing
// Stripe subscription wins (max over pro), then the self-serve free tier, then
// null. Users absent from the DB are simply not set (callers treat missing as
// null via limitsFor).
export async function getActivationLevels(
    userIds: string[],
): Promise<Map<string, ActivationLevel | null>> {
    const levels = new Map<string, ActivationLevel | null>();
    if (userIds.length === 0) return levels;

    const { rows } = await db.query<{
        id: string;
        user_plan: string | null;
        sub_plan: string | null;
    }>(
        `select u.id, u.plan as user_plan,
                (select s.plan from subscription s
                  where s."referenceId" = u.id and s.status in ('active', 'trialing')
                  order by case when s.plan = 'max' then 0 else 1 end
                  limit 1) as sub_plan
           from "user" u where u.id = any($1::text[])`,
        [userIds],
    );
    for (const row of rows) {
        levels.set(
            row.id,
            row.sub_plan !== null && isPaidPlan(row.sub_plan)
                ? row.sub_plan
                : row.user_plan === "free"
                  ? "free"
                  : null,
        );
    }
    return levels;
}

// shared session guard for server actions (public POST endpoints)
export async function requireUser() {
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });
    if (!session?.user) redirect("/onboard");
    return { requestHeaders, session };
}
