import { timingSafeEqual } from "node:crypto";

// Shared bearer-token gate for the service-to-service endpoints (the cron tick,
// the Discord event ingress, and the subscription feed) — every one is called
// only by saturn_admin, which holds CRON_SECRET. Constant-time compare; returns
// false when the secret is unset so a caller can never authorize while
// misconfigured. Each route still returns 500 on an unset secret before this,
// so it never operates open.
export function serviceAuthorized(header: string | null): boolean {
    const secret = process.env.CRON_SECRET;
    if (!secret || !header) return false;
    const expected = Buffer.from(`Bearer ${secret}`);
    const got = Buffer.from(header);
    return got.length === expected.length && timingSafeEqual(got, expected);
}
