// Built-in model credits (server-only). Source of truth is the model_usage
// ledger (db/setup.sql): balance is derived as tier allowance minus the sum of
// credits spent since the current Stripe billing period started — no balance
// column, no reset job. Free tier (no subscription, so no period) uses the
// same 30-day-lookback fallback as its window: a rolling month, credits free
// up as old usage ages out. Not-activated users (level null) get no allowance
// even though limitsFor(null) returns free limits. 1,000 credits = $1 of
// OpenRouter cost; each platform-billed turn debits ceil(cost * 1000).
//
// The check-then-call-then-record sequence in executeAgentTurn is deliberately
// non-transactional: concurrent in-flight turns can each pass the balance
// check and overshoot the allowance by ~one turn, bounded by the 4096
// max_tokens cap (cents). The ledger records actual spend either way and the
// next turn hard-stops.
import { createTtlCache } from "@/lib/cache.server";
import { db } from "@/lib/db";
import { SELF_HOSTED } from "@/lib/selfhost";
import { isPaidPlan, limitsFor, type ActivationLevel } from "@/lib/subscription";

// per-user usage cache — recordUsage increments the cached entry in place so
// same-process turns stay exact; the TTL only bounds staleness of external
// writes (tier changes, another process). Single-process invariant per
// lib/cache.server.ts.
const usageCache = createTtlCache<CreditUsage>(60_000);

// platform OpenRouter key that pays for built-in credits. Optional — when
// unset, everyone falls back to BYOK and no credits are ever spent.
export const platformKey = () => process.env.PLATFORM_OPENROUTER_KEY || null;

export type CreditUsage = {
    level: ActivationLevel | null;
    allowance: number; // credits per billing period for the tier
    used: number; // credits spent since periodStart
    periodStart: Date | null; // null = no live paid subscription
    periodEnd: Date | null;
};

// tier + billing period + period spend for one user. Headless (no request
// headers) so the designer action path and the cron runner resolve
// identically; the tier branch mirrors getActivationLevels in
// lib/subscription.ts.
export async function getCreditUsage(userId: string): Promise<CreditUsage> {
    // self-hosted: no credit system — report max with a zero allowance so the
    // key-selection paths skip platform-credit billing and use the platform key
    // directly. No SQL, no cache.
    if (SELF_HOSTED) {
        return { level: "max", allowance: 0, used: 0, periodStart: null, periodEnd: null };
    }
    return usageCache.getOrLoad(userId, () => loadCreditUsage(userId));
}

async function loadCreditUsage(userId: string): Promise<CreditUsage> {
    const { rows } = await db.query<{
        user_plan: string | null;
        sub_plan: string | null;
        period_start: Date | null;
        period_end: Date | null;
    }>(
        `select u.plan as user_plan, s.plan as sub_plan,
                s."periodStart" as period_start, s."periodEnd" as period_end
           from "user" u
           left join lateral (
                 select plan, "periodStart", "periodEnd" from subscription
                  where "referenceId" = u.id and status in ('active', 'trialing')
                  order by case when plan = 'max' then 0 else 1 end
                  limit 1
                ) s on true
          where u.id = $1`,
        [userId],
    );
    const row = rows[0];
    const level: ActivationLevel | null =
        row?.sub_plan != null && isPaidPlan(row.sub_plan)
            ? row.sub_plan
            : row?.user_plan === "free"
              ? "free"
              : null;
    // level null (signed in, never activated) gets no credits — don't fall
    // through to limitsFor's null→free mapping here
    const allowance = level ? limitsFor(level).modelCredits : 0;
    const periodStart = (row?.sub_plan != null && row.period_start) || null;
    const periodEnd = (row?.sub_plan != null && row.period_end) || null;
    if (allowance === 0) return { level, allowance, used: 0, periodStart, periodEnd };

    // a live paid sub with a null periodStart (webhook not yet delivered) must
    // never mean an unlimited window — fall back to a 30-day lookback
    const since = periodStart ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const sum = await db.query<{ used: number }>(
        `select coalesce(sum(credits), 0)::int as used
           from model_usage where user_id = $1 and created_at >= $2`,
        [userId, since],
    );
    return { level, allowance, used: sum.rows[0]?.used ?? 0, periodStart, periodEnd };
}

// debit one platform-billed turn. Never throws — a failed insert must not
// fail an already-completed model call (the turn goes unbilled instead).
export async function recordUsage(
    userId: string,
    u: {
        model: string;
        costUsd: number;
        promptTokens: number;
        completionTokens: number;
        source: "designer" | "cron" | "manual" | "event";
    },
): Promise<void> {
    // self-hosted: nothing is metered — the platform key funds every call
    if (SELF_HOSTED) return;
    const credits = Math.ceil(Math.max(0, u.costUsd) * 1000);
    try {
        await db.query(
            `insert into model_usage
                 (user_id, model, credits, cost_microdollars, prompt_tokens, completion_tokens, source)
             values ($1, $2, $3, $4, $5, $6, $7)`,
            [
                userId,
                u.model,
                credits,
                Math.round(Math.max(0, u.costUsd) * 1e6),
                Math.max(0, Math.floor(u.promptTokens)),
                Math.max(0, Math.floor(u.completionTokens)),
                u.source,
            ],
        );
        // keep the cached balance exact for same-process turns (the next
        // balance check must see this spend without waiting out the TTL)
        const cached = usageCache.get(userId);
        if (cached) usageCache.set(userId, { ...cached, used: cached.used + credits });
    } catch (err) {
        console.error("model_usage insert failed", err);
        usageCache.delete(userId);
    }
}
