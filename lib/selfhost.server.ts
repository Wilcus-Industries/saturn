// Server-only self-hosted helpers: the synthetic owner user + session that
// stand in for better-auth when SELF_HOSTED=1. See lib/selfhost.ts for the
// mode flag. Never import this from a client component.
import type { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { seedExampleWorkflow } from "@/lib/exampleWorkflow.server";
import { SELF_HOSTED_USER_ID } from "@/lib/selfhost";

// per-container sandbox resource quotas for self-hosted mode (no tiers). Sized
// generously — a self-hoster owns the box — but still parsed from env so an
// operator can dial it to their hardware. Non-numeric / non-positive → default.
function envPositiveInt(name: string, fallback: number): number {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
function envPositiveNumber(name: string, fallback: number): number {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const SELF_HOSTED_SANDBOX = {
    memoryMb: envPositiveInt("SANDBOX_MEMORY_MB", 1024),
    cpus: envPositiveNumber("SANDBOX_CPUS", 2),
    diskMb: envPositiveInt("SANDBOX_DISK_MB", 8192),
    execTimeoutS: envPositiveInt("SANDBOX_EXEC_TIMEOUT_S", 600),
} as const;

// module-load timestamp reused for the synthetic user's created/updated times
const OWNER_SINCE = new Date();

// insert-once owner row. The better-auth user.create hook (which seeds the
// example workflow) never fires for raw SQL, so we seed on first insert here.
// Memoized so it runs once per process; the memo is cleared on failure so a
// later call retries. Never throws — mirrors the seed hook convention in
// lib/auth.ts (a throw would break every page/action under the flag).
let ensurePromise: Promise<void> | null = null;

export function ensureSelfHostedUser(): Promise<void> {
    if (!ensurePromise) {
        ensurePromise = (async () => {
            try {
                const { rows } = await db.query<{ id: string }>(
                    `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
                     values ($1, 'Owner', 'owner@localhost', true, now(), now())
                     on conflict (id) do nothing
                     returning id`,
                    [SELF_HOSTED_USER_ID],
                );
                // a returned row means we actually inserted (first boot) — seed
                // the example workflow the way the create hook would have
                if (rows.length > 0) {
                    await seedExampleWorkflow(SELF_HOSTED_USER_ID);
                }
            } catch (err) {
                console.error("ensureSelfHostedUser failed", err);
                ensurePromise = null; // let a later call retry
            }
        })();
    }
    return ensurePromise;
}

// synthetic session shaped like auth.api.getSession's result. Cast once here
// (the plan additionalField and timestamps make an exact structural match
// verbose and brittle) so callers get the real return type without `any`.
type SessionResult = Awaited<ReturnType<typeof auth.api.getSession>>;

const SELF_HOSTED_SESSION = {
    session: {
        id: SELF_HOSTED_USER_ID,
        userId: SELF_HOSTED_USER_ID,
        createdAt: OWNER_SINCE,
        updatedAt: OWNER_SINCE,
        expiresAt: new Date(OWNER_SINCE.getTime() + 365 * 24 * 60 * 60 * 1000),
        token: "self-hosted",
        ipAddress: null,
        userAgent: null,
    },
    user: {
        id: SELF_HOSTED_USER_ID,
        name: "Owner",
        email: "owner@localhost",
        emailVerified: true,
        image: null,
        createdAt: OWNER_SINCE,
        updatedAt: OWNER_SINCE,
        plan: null,
    },
} as unknown as NonNullable<SessionResult>;

// awaits the owner row (so requireUser and any downstream FK write is safe),
// then returns the synthetic session. Never null under the flag.
export async function selfHostedSession(): Promise<SessionResult> {
    await ensureSelfHostedUser();
    return SELF_HOSTED_SESSION;
}
