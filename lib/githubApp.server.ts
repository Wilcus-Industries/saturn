// Central GitHub App webhook path: instant, HMAC-verified event delivery that
// fans into the same ingestEvent pipeline as the Events-API poller
// (lib/github.server.ts). One operator-registered app → one webhook URL + one
// secret in server env (GITHUB_WEBHOOK_SECRET); users click "install on repo"
// on GitHub and Saturn receives signed deliveries here. Env unset → the HTTP
// route 404s and this whole path is dormant (poller-only, graceful degrade).
//
// This module owns webhook-body → Saturn-payload translation (byte-matching the
// poller builders and lib/integrations.ts samplePayloads), the installation→user
// mapping table helpers (github_installation, private-repo owner binding), and
// the delivery orchestration. It reuses the poller's shared seams — subWantsEvent
// / dispatchGithubEvent / the source-tagged dedupe ledger — so both delivery
// paths match subscriptions and dedupe identically. No boot wiring: HTTP routes
// need no startBackground(). No app private key anywhere — zero JWT/API-as-app
// calls.
import "server-only";

import { createTtlCache } from "@/lib/cache.server";
import { db } from "@/lib/db";
import {
    type EventSubscription,
    getEventSubscriptions,
    onSubscriptionsChanged,
} from "@/lib/events.server";
import {
    asArr,
    asObj,
    asStr,
    branchFromRef,
    buildIssue,
    buildPr,
    buildRelease,
    claimWebhookDelivery,
    dispatchGithubEvent,
    githubFingerprint,
    MAX_COMMIT_MESSAGE_CHARS,
    MAX_COMMIT_MESSAGES,
    subWantsEvent,
} from "@/lib/github.server";

// lazy read (call time, not module load): env can be set after this module is
// first evaluated, and the HTTP route gates every request on this.
export function githubWebhookConfigured(): boolean {
    return !!process.env.GITHUB_WEBHOOK_SECRET;
}

// The full app is "configured" only when every piece of the OAuth-verified
// install flow exists too (slug + client credentials) alongside the webhook
// secret. Gates the settings card and the install/callback routes — unset any
// one and self-hosters / unconfigured operators see nothing (poller-only).
export function githubAppConfigured(): boolean {
    return (
        !!process.env.GITHUB_WEBHOOK_SECRET &&
        !!process.env.GITHUB_APP_SLUG &&
        !!process.env.GITHUB_APP_CLIENT_ID &&
        !!process.env.GITHUB_APP_CLIENT_SECRET
    );
}

// ---------------------------------------------------------------------------
// Installation → user mapping (github_installation table in db/setup.sql).
// Private-repo webhook deliveries are bound to the installing Saturn user via
// the OAuth-verified setup flow; this is the lookup side.
// ---------------------------------------------------------------------------

export type InstallationRow = { userId: string; accountLogin: string };

// 60s TTL over getInstallation; misses (null) are cached too — a null is a
// successful load, so getOrLoad populates it and honors the same staleness
// bound. Every upsert/delete invalidates the key so writes are visible at once.
const installCache = createTtlCache<InstallationRow | null>(60_000);

export async function getInstallation(installationId: number): Promise<InstallationRow | null> {
    return installCache.getOrLoad(String(installationId), async () => {
        const { rows } = await db.query<{ user_id: string; account_login: string }>(
            "select user_id, account_login from github_installation where installation_id = $1",
            [installationId],
        );
        const row = rows[0];
        return row ? { userId: row.user_id, accountLogin: row.account_login } : null;
    });
}

export async function upsertInstallation(
    installationId: number,
    userId: string,
    accountLogin: string,
): Promise<void> {
    await db.query(
        `insert into github_installation (installation_id, user_id, account_login, updated_at)
         values ($1, $2, $3, now())
         on conflict (installation_id) do update
             set user_id = excluded.user_id,
                 account_login = excluded.account_login,
                 updated_at = now()`,
        [installationId, userId, accountLogin],
    );
    installCache.delete(String(installationId));
}

export async function deleteInstallation(installationId: number): Promise<void> {
    await db.query("delete from github_installation where installation_id = $1", [installationId]);
    installCache.delete(String(installationId));
}

// settings-card unlink: ownership-scoped delete (only the row belonging to this
// user). Returns whether a row was removed so the caller can surface "not found"
// without leaking whether the installation exists under another owner.
export async function deleteInstallationOwned(
    installationId: number,
    userId: string,
): Promise<boolean> {
    const { rowCount } = await db.query(
        "delete from github_installation where installation_id = $1 and user_id = $2",
        [installationId, userId],
    );
    installCache.delete(String(installationId));
    return !!rowCount;
}

// settings card: the user's linked installations (bigint comes back as a string
// from pg — Number() is safe, installation ids sit well inside 2^53).
export async function listInstallations(
    userId: string,
): Promise<{ installationId: number; accountLogin: string }[]> {
    const { rows } = await db.query<{ installation_id: string; account_login: string }>(
        `select installation_id, account_login from github_installation
          where user_id = $1 order by created_at`,
        [userId],
    );
    return rows.map((r) => ({
        installationId: Number(r.installation_id),
        accountLogin: r.account_login,
    }));
}

// ---------------------------------------------------------------------------
// Webhook-body → Saturn-payload translation. Every payload byte-matches the
// matching poller builder / lib/integrations.ts samplePayload (all scalars are
// strings) — drift would break users' extract paths. Webhook bodies nest the
// issue/pull_request/release objects identically to the Events API payloads, so
// buildIssue/buildPr/buildRelease are reused verbatim; the webhook body carries
// full commit data, so the push path needs no compare-API enrichment.
// ---------------------------------------------------------------------------

export function mapWebhookEvent(
    eventName: string,
    body: Record<string, unknown>,
): { event: string; payload: Record<string, unknown> } | null {
    const repository = asObj(body.repository);
    const repo = asStr(repository.full_name);
    const action = asStr(body.action);

    switch (eventName) {
        case "push": {
            // a branch/tag delete carries deleted:true and no commits — the
            // poller ignores DeleteEvent, so we skip here for parity
            if (body.deleted === true) return null;
            const ref = asStr(body.ref);
            const commits = asArr(body.commits);
            const before = asStr(body.before);
            const head = asStr(body.after);
            const pusher = asStr(asObj(body.pusher).name) || asStr(asObj(body.sender).login);
            const compareUrl =
                asStr(body.compare) ||
                (before && head
                    ? `${asStr(repository.html_url)}/compare/${before}...${head}`
                    : "");
            return {
                event: "github-push",
                payload: {
                    repo,
                    ref,
                    branch: branchFromRef(ref),
                    pusher,
                    // zero-commit / force pushes still deliver ("0", [])
                    commitCount: String(commits.length),
                    headSha: head,
                    beforeSha: before,
                    messages: commits
                        .slice(0, MAX_COMMIT_MESSAGES)
                        .map((c) => asStr(asObj(c).message).slice(0, MAX_COMMIT_MESSAGE_CHARS)),
                    compareUrl,
                    timestamp: asStr(asObj(body.head_commit).timestamp) || new Date().toISOString(),
                },
            };
        }
        case "issues":
            return action === "opened"
                ? {
                      event: "github-issue",
                      payload: buildIssue(repo, asStr(asObj(body.issue).created_at), body),
                  }
                : null;
        case "pull_request":
            return action === "opened"
                ? {
                      event: "github-pr",
                      payload: buildPr(repo, asStr(asObj(body.pull_request).created_at), body),
                  }
                : null;
        case "release":
            return action === "published"
                ? {
                      event: "github-release",
                      payload: buildRelease(repo, asStr(asObj(body.release).published_at), body),
                  }
                : null;
        case "star":
            return action === "created"
                ? {
                      event: "github-star",
                      payload: {
                          repo,
                          user: asStr(asObj(body.sender).login),
                          timestamp: asStr(body.starred_at) || new Date().toISOString(),
                      },
                  }
                : null;
        default:
            return null; // any other event (incl. `watch`, which we don't subscribe) — ignored
    }
}

// ---------------------------------------------------------------------------
// Delivery orchestration.
// ---------------------------------------------------------------------------

// 15-min TTL set on the x-github-delivery GUID — absorbs GitHub retries and
// manual redeliveries. Written unconditionally on first sight, before any skip
// path, so a redelivery of a skipped event is also short-circuited.
const deliveryIdSeen = createTtlCache<true>(15 * 60_000, 5_000);

// github subscriptions behind a 15s single-key TTL cache; the module-singleton
// listener (registered once, repo-wide pattern) clears it when a workflow
// mutation pokes subscriptionsChanged() so freshly saved/deleted event nodes
// take effect within 15s worst case.
const subsCache = createTtlCache<EventSubscription[]>(15_000, 4);
let subsListenerRegistered = false;

function githubSubscriptions(): Promise<EventSubscription[]> {
    if (!subsListenerRegistered) {
        subsListenerRegistered = true;
        onSubscriptionsChanged(() => subsCache.clear());
    }
    return subsCache.getOrLoad("github", async () =>
        (await getEventSubscriptions()).filter((s) => s.provider === "github"),
    );
}

const ok = (msg: string) => new Response(msg, { status: 200 });

// Handle one verified webhook delivery. The HTTP route (app/api/github/webhook)
// owns env gate / size limits / signature / ping; by the time we're here the
// body is authenticated. Never awaits the runs (GitHub's 10s delivery timeout).
// Never logs secrets or full payloads — event name + repo + delivery id only.
export async function handleGithubDelivery(
    eventName: string,
    deliveryId: string,
    rawBody: string,
): Promise<Response> {
    // 1. delivery-id dedupe — write unconditionally, even for the skip paths
    if (deliveryId) {
        if (deliveryIdSeen.get(deliveryId)) return ok("duplicate delivery");
        deliveryIdSeen.set(deliveryId, true);
    }

    // 2. parse
    let body: Record<string, unknown>;
    try {
        const parsed: unknown = JSON.parse(rawBody);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
            throw new Error("not an object");
        body = parsed as Record<string, unknown>;
    } catch {
        return new Response("invalid JSON body", { status: 400 });
    }

    const repository = asObj(body.repository);
    const repoFullName = asStr(repository.full_name);
    const installation = asObj(body.installation);
    const installationId = typeof installation.id === "number" ? installation.id : 0;

    // 3. installation lifecycle — sync uninstall, no-op other admin actions
    if (eventName === "installation") {
        if (asStr(body.action) === "deleted" && installationId) {
            await deleteInstallation(installationId);
            console.log(`[github app] installation ${installationId} uninstalled — row deleted`);
        }
        return ok("installation event handled");
    }

    // 4. translate to a Saturn event
    const mapped = mapWebhookEvent(eventName, body);
    if (!mapped) return ok("event ignored");
    const { event, payload } = mapped;

    // 5. matching subscriptions. botToken is deliberately ignored on this path:
    // a sub whose optional token is malformed (which the poller would skip)
    // still gets instant webhook delivery — a strict improvement.
    let subs: EventSubscription[];
    try {
        subs = await githubSubscriptions();
    } catch (err) {
        console.error(`[github app] subscription lookup failed: ${(err as Error).message}`);
        return new Response("subscription lookup failed", { status: 500 });
    }
    const repoLower = repoFullName.toLowerCase();
    let matching = subs.filter(
        (sub) =>
            (sub.config.repo ?? "").toLowerCase() === repoLower &&
            subWantsEvent(sub, event, payload),
    );

    // 6. privacy filter: private (or `internal`, or a missing flag) repos deliver
    // only to the installing user. No linked installation row → leave it to the
    // poller: return WITHOUT claiming the fingerprint so the poller still fires.
    const isPrivate = repository.private !== false;
    if (isPrivate && matching.length) {
        const row = await getInstallation(installationId);
        if (!row) {
            console.log(
                `[github app] ${event} on ${repoFullName} (delivery ${deliveryId}) — private repo, no linked installation — leaving to poller`,
            );
            return ok("private repo without linked installation");
        }
        matching = matching.filter((sub) => sub.userId === row.userId);
    }

    if (!matching.length) return ok("no matching subscriptions");

    // 7. claim the content fingerprint — loses to a poller that already delivered
    if (!claimWebhookDelivery(githubFingerprint(event, payload))) return ok("already delivered");

    // 8. fire-and-forget per sub — never await runs (GitHub 10s delivery timeout)
    for (const sub of matching)
        void dispatchGithubEvent(sub, payload, "github-app").catch((err) =>
            console.error(
                `[github app] dispatch failed for workflow ${sub.workflowId}: ${(err as Error).message}`,
            ),
        );

    console.log(
        `[github app] ${event} on ${repoFullName} → ${matching.length} run(s) (delivery ${deliveryId})`,
    );
    return ok("delivered");
}
