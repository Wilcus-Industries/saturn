// In-process GitHub Events API poller, started from
// lib/background.server.ts on production server boot:
//
//   - reads the normalized inbound-event subscriptions straight from the DB
//     (lib/events.server.ts getEventSubscriptions, filtered to
//     provider === "github") every 60s, plus immediately (2s debounce) when a
//     workflow mutation pokes subscriptionsChanged(),
//   - holds ONE poller per distinct (token, repo) pair — many workflows and
//     event types can watch the same repo/token, so they share one fetch, one
//     ETag, and one cursor; each fetched event fans out over the poller's subs
//     filtered by sub.event. GitHub polling is multi-consumer-safe (no single
//     getUpdates constraint), so several instances polling one repo would each
//     just get their own quota — no conflict.
//   - each poll is a conditional GET of
//     https://api.github.com/repos/{owner}/{repo}/events with if-none-match:
//     a 304 costs no rate-limit quota, and X-Poll-Interval (clamped [60,300]s)
//     sets the cadence. per_page is a constant — changing it invalidates the
//     ETag.
//
// The cursor is a baseline event id, not a timestamp: GitHub event ids are
// monotonically increasing numeric strings (compared via BigInt). The first
// successful poll records the max id and dispatches nothing — no history
// replay on boot (the Events API itself lags up to ~5 min, so id, not time,
// is the cursor); a 900s created_at backstop is the secondary guard.
//
// The access token is optional (public repos poll unauthenticated at 60 req/hr
// — but 304s are free; a PAT raises that to 5000/hr and reaches private repos)
// and is charset-validated: a malformed token (e.g. a deleted-variable
// sentinel left literal in the optional field) skips that subscription with a
// warning rather than polling with garbage.
//
// Error taxonomy diverges from telegram: 401 (bad token) permanently kills the
// poller until the token value changes, but 404/451 (repo renamed/typo/private
// beyond the token) are NOT dead — they are fixable outside Saturn, so the
// poller retries every 15 min with a hint. 403/429 rate limits sleep to the
// reset; 5xx/network/parse failures exponentially back off.
import {
    type EventSubscription,
    getEventSubscriptions,
    ingestEvent,
    MAX_EVENT_PAYLOAD,
    onSubscriptionsChanged,
} from "@/lib/events.server";

const POLL_INTERVAL_MS = 60_000; // reconciliation sweep
const REFRESH_DEBOUNCE_MS = 2_000;
const DEFAULT_POLL_S = 60; // per-poller cadence; also the [60,300] clamp floor
const MAX_POLL_S = 300; // X-Poll-Interval clamp ceiling
const PER_PAGE = 50; // constant — changing it invalidates the ETag
const FETCH_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;
const RATE_LIMIT_MIN_SLEEP_MS = 60_000; // rate-limit sleep clamp [60s,1h]
const RATE_LIMIT_MAX_SLEEP_MS = 3_600_000;
const NOT_FOUND_RETRY_MS = 900_000; // 404/451 retry cadence (repo fixable outside Saturn)
const SKIP_OLDER_THAN_S = 900; // created_at backstop against replay
const MAX_BODY_CHARS = 4_000; // issue/pr/release body truncation
const MAX_COMMIT_MESSAGES = 5;
const MAX_COMMIT_MESSAGE_CHARS = 200;
const ENRICH_TIMEOUT_MS = 10_000; // push compare-call enrichment
const GUARD_BODY_CHARS = 1_000; // final re-slice when JSON exceeds MAX_EVENT_PAYLOAD

// GitHub rejects requests without a User-Agent; the api-version + accept
// headers pin the response shape.
const USER_AGENT = "Saturn-Workflows (https://saturn.wilcus.com)";
const GITHUB_ACCEPT = "application/vnd.github+json";
const GITHUB_API_VERSION = "2022-11-28";
const HEADS_PREFIX = "refs/heads/";

// config never shapes the fetch target: repo is exact owner/repo (no path
// traversal — the regex forbids a second slash, and "."/".." whole segments
// are rejected below), token rides the Authorization header only.
const REPO_RE = /^[A-Za-z0-9_.-]{1,60}\/[A-Za-z0-9_.-]{1,120}$/;
const TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/; // compare-URL endpoints (from the API payload)

type GithubEvent = {
    id?: string;
    type?: string;
    actor?: { login?: string };
    repo?: { name?: string };
    created_at?: string;
    payload?: Record<string, unknown>;
};

/** Never log a full token — identify pollers by their tail. */
const fp = (token: string) => `…${token.slice(-4)}`;

// untrusted-payload accessors: the API response is never assumed well-shaped
const asObj = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
const asStr = (v: unknown): string => (typeof v === "string" ? v : "");
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const numStr = (v: unknown): string =>
    typeof v === "number" ? String(v) : typeof v === "string" ? v : "";

// repo must be exactly owner/repo with no traversal segment
function validRepo(repo: string): boolean {
    if (!REPO_RE.test(repo)) return false;
    const [owner, name] = repo.split("/");
    return owner !== "." && owner !== ".." && name !== "." && name !== "..";
}

// event id → BigInt cursor value, or null for a malformed id (skipped)
function parseEventId(id: unknown): bigint | null {
    if (typeof id !== "string" || !/^\d+$/.test(id)) return null;
    try {
        return BigInt(id);
    } catch {
        return null;
    }
}

const clampRateSleep = (ms: number) =>
    Math.min(Math.max(ms, RATE_LIMIT_MIN_SLEEP_MS), RATE_LIMIT_MAX_SLEEP_MS);

const pollers = new Map<string, GithubRepoPoller>();
let pollTimer: NodeJS.Timeout | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let unsubscribe: (() => void) | null = null;
let stopped = false;

class GithubRepoPoller {
    key: string;
    token: string; // "" = unauthenticated
    repo: string; // original casing (URL); the map key lower-cases it
    subs: EventSubscription[];
    etag: string | null = null;
    lastEventId: bigint | null = null; // null = baseline not yet recorded
    pollIntervalS = DEFAULT_POLL_S;
    abort: AbortController | null = null;
    sleepTimer: NodeJS.Timeout | null = null;
    wakeSleep: (() => void) | null = null;
    backoffMs = 1_000;
    dead = false; // 401 — never poll this token value again
    destroyed = false;

    constructor(key: string, token: string, repo: string, subs: EventSubscription[]) {
        this.key = key;
        this.token = token;
        this.repo = repo;
        this.subs = subs;
        void this.loop();
    }

    tag() {
        return this.token ? `${this.repo} ${fp(this.token)}` : this.repo;
    }

    async loop() {
        while (!this.destroyed && !this.dead) {
            let res: Response;
            let bodyText: string;
            try {
                this.abort = new AbortController();
                // manual timeout so destroy() can also abort the same fetch
                const timeout = setTimeout(() => this.abort?.abort(), FETCH_TIMEOUT_MS);
                try {
                    const headers: Record<string, string> = {
                        "user-agent": USER_AGENT,
                        accept: GITHUB_ACCEPT,
                        "x-github-api-version": GITHUB_API_VERSION,
                    };
                    if (this.token) headers.authorization = `Bearer ${this.token}`;
                    if (this.etag) headers["if-none-match"] = this.etag;
                    res = await fetch(
                        `https://api.github.com/repos/${this.repo}/events?per_page=${PER_PAGE}`,
                        { headers, signal: this.abort.signal },
                    );
                    bodyText = await res.text();
                } finally {
                    clearTimeout(timeout);
                    this.abort = null;
                }
            } catch {
                // destroy() abort or network failure — backoff (the while
                // condition handles the destroyed case)
                await this.backoff();
                continue;
            }

            // 304 Not Modified — no new events, no quota spent. Reset backoff,
            // wait out the poll interval.
            if (res.status === 304) {
                this.updatePollInterval(res);
                this.backoffMs = 1_000;
                await this.sleep(this.pollIntervalS * 1_000);
                continue;
            }
            // 401 — bad/expired token, permanent until the token value changes
            if (res.status === 401) {
                this.dead = true;
                console.error(
                    `[github ${this.tag()}] giving up: authentication failed — check the access token (a PAT with repo read access)`,
                );
                return;
            }
            // 403/429 — primary or secondary rate limit
            if (res.status === 403 || res.status === 429) {
                await this.handleRateLimit(res, bodyText);
                continue;
            }
            // 404/451 — repo missing/renamed-away/blocked, or the token can't
            // see a private repo. NOT permanent: fixable outside Saturn (rename
            // the config, or grant the token access), so retry every 15 min.
            if (res.status === 404 || res.status === 451) {
                console.error(
                    `[github ${this.tag()}] repo not accessible (${res.status}) — check that ${this.repo} exists and the token (if any) can read it; retrying in 15 min`,
                );
                await this.sleep(NOT_FOUND_RETRY_MS);
                continue;
            }
            if (!res.ok) {
                // 5xx or unexpected status — exponential backoff
                console.error(
                    `[github ${this.tag()}] events fetch failed (${res.status}): ${bodyText.slice(0, 200)}`,
                );
                await this.backoff();
                continue;
            }

            let events: GithubEvent[];
            try {
                const json: unknown = JSON.parse(bodyText);
                if (!Array.isArray(json)) throw new Error("not an array");
                events = json as GithubEvent[];
            } catch {
                console.error(`[github ${this.tag()}] could not parse events response`);
                await this.backoff();
                continue;
            }

            this.etag = res.headers.get("etag") ?? this.etag;
            this.updatePollInterval(res);
            this.backoffMs = 1_000;
            this.handleEvents(events);
            await this.sleep(this.pollIntervalS * 1_000);
        }
    }

    // clamp X-Poll-Interval into [DEFAULT_POLL_S, MAX_POLL_S] so a bad header
    // can neither stall nor hammer; keep the current value when absent
    updatePollInterval(res: Response) {
        const raw = res.headers.get("x-poll-interval");
        if (raw === null) return; // absent — keep the current cadence
        const n = Number(raw);
        if (Number.isFinite(n))
            this.pollIntervalS = Math.min(Math.max(n, DEFAULT_POLL_S), MAX_POLL_S);
    }

    async handleRateLimit(res: Response, bodyText: string) {
        // Retry-After (seconds) wins when present — used for secondary limits
        const retryAfter = Number(res.headers.get("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
            await this.sleep(clampRateSleep(retryAfter * 1_000));
            return;
        }
        // primary limit: X-RateLimit-Remaining 0 → sleep until the reset (+2s)
        const remaining = res.headers.get("x-ratelimit-remaining");
        const reset = Number(res.headers.get("x-ratelimit-reset")); // unix seconds
        if (remaining === "0" && Number.isFinite(reset)) {
            const ms = clampRateSleep(reset * 1_000 - Date.now() + 2_000);
            console.error(
                `[github ${this.tag()}] rate limited — waiting ${Math.round(ms / 1_000)}s for reset; an access token via a variable node raises the limit to 5000/hr`,
            );
            await this.sleep(ms);
            return;
        }
        // other 403 (permissions, headerless secondary limit) — backoff + hint
        console.error(
            `[github ${this.tag()}] forbidden (${res.status}): ${bodyText.slice(0, 200)} — check the access token's permissions`,
        );
        await this.backoff();
    }

    // Events API returns newest-first. First success records a baseline and
    // dispatches nothing; later polls dispatch id > cursor oldest-first and
    // advance the cursor unconditionally (ack even filtered/unknown events).
    handleEvents(events: GithubEvent[]) {
        if (this.lastEventId === null) {
            let max: bigint | null = null;
            for (const ev of events) {
                const id = parseEventId(ev.id);
                if (id !== null && (max === null || id > max)) max = id;
            }
            this.lastEventId = max ?? BigInt(0);
            return;
        }
        let max = this.lastEventId;
        const fresh: GithubEvent[] = [];
        for (const ev of events) {
            const id = parseEventId(ev.id);
            if (id === null) continue; // malformed id — skip
            if (id > this.lastEventId) fresh.push(ev);
            if (id > max) max = id;
        }
        this.lastEventId = max;
        fresh.reverse(); // newest-first → oldest-first
        for (const ev of fresh) {
            // secondary backstop: never act on stale events (created_at > 900s)
            const created = Date.parse(asStr(ev.created_at));
            if (Number.isFinite(created) && Date.now() - created > SKIP_OLDER_THAN_S * 1_000)
                continue;
            this.route(ev).catch((err) => {
                console.error(`[github ${this.tag()}] event routing failed: ${err.message}`);
            });
        }
    }

    // map one event to its descriptor + payload once, then fan out over the
    // subs that want it (N workflows/event types on one repo → N dispatches)
    async route(ev: GithubEvent) {
        const built = build(ev, this.repo);
        if (!built) return;
        const interested = this.subs.filter((sub) => {
            if (sub.event !== built.event) return false;
            // push branch filter (optional): match refs/heads/<branch> exactly.
            // A tag push carries branch "" and so never matches a set filter.
            return !(
                built.event === "github-push" &&
                sub.config.branch &&
                sub.config.branch !== built.payload.branch
            );
        });
        if (!interested.length) return;
        // the Events API PushEvent payload carries only ref/head/before (no
        // commits/size) — fill commitCount/messages from one compare call,
        // once per event, only when someone actually wants it
        if (built.event === "github-push") await this.enrichPush(built.payload);
        for (const sub of interested) {
            // fire-and-forget: the run executes inline (up to RUN_TIMEOUT_MS)
            // — never block the poll loop on it
            this.dispatch(sub, built.payload).catch((err) => {
                console.error(
                    `[github ${this.tag()}] event dispatch failed for workflow ${sub.workflowId}: ${err.message}`,
                );
            });
        }
    }

    // best-effort: failures keep commitCount "0" / messages [] — a delivery
    // must never be dropped because the enrichment call failed
    async enrichPush(payload: Record<string, unknown>) {
        const before = asStr(payload.beforeSha);
        const head = asStr(payload.headSha);
        // shas come from the API payload, but keep the URL-shaping discipline
        if (!SHA_RE.test(before) || !SHA_RE.test(head)) return;
        try {
            const abort = new AbortController();
            const timeout = setTimeout(() => abort.abort(), ENRICH_TIMEOUT_MS);
            let res: Response;
            try {
                const headers: Record<string, string> = {
                    "user-agent": USER_AGENT,
                    accept: GITHUB_ACCEPT,
                    "x-github-api-version": GITHUB_API_VERSION,
                };
                if (this.token) headers.authorization = `Bearer ${this.token}`;
                res = await fetch(
                    `https://api.github.com/repos/${this.repo}/compare/${before}...${head}`,
                    { headers, signal: abort.signal },
                );
            } finally {
                clearTimeout(timeout);
            }
            if (!res.ok) return; // e.g. 404 after a force push — keep defaults
            const cmp = asObj(JSON.parse(await res.text()));
            if (typeof cmp.total_commits === "number")
                payload.commitCount = String(cmp.total_commits);
            payload.messages = asArr(cmp.commits)
                .slice(0, MAX_COMMIT_MESSAGES)
                .map((c) => asStr(asObj(asObj(c).commit).message).slice(0, MAX_COMMIT_MESSAGE_CHARS));
        } catch {
            // network/parse failure — deliver the un-enriched payload
        }
    }

    async dispatch(sub: EventSubscription, payloadObj: Record<string, unknown>) {
        let payload = JSON.stringify(payloadObj);
        if (payload.length > MAX_EVENT_PAYLOAD) {
            // never trip the ingest shape cap — re-slice the only unbounded
            // field (issue/pr/release body) and re-stringify
            if (typeof payloadObj.body === "string")
                payloadObj.body = payloadObj.body.slice(0, GUARD_BODY_CHARS);
            payload = JSON.stringify(payloadObj);
        }
        const result = await ingestEvent({
            workflowId: sub.workflowId,
            nodeId: sub.nodeId,
            payload,
        });
        console.log(
            `[github ${this.tag()}] delivered to workflow ${sub.workflowId}: ${JSON.stringify(result).slice(0, 200)}`,
        );
    }

    // abortable sleep — destroy() resolves it early so the loop exits promptly
    sleep(ms: number) {
        return new Promise<void>((resolve) => {
            this.wakeSleep = resolve;
            this.sleepTimer = setTimeout(() => {
                this.sleepTimer = null;
                this.wakeSleep = null;
                resolve();
            }, ms);
        });
    }

    backoff() {
        const ms = this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
        return this.sleep(ms);
    }

    destroy() {
        this.destroyed = true;
        this.abort?.abort();
        if (this.sleepTimer) {
            clearTimeout(this.sleepTimer);
            this.sleepTimer = null;
        }
        this.wakeSleep?.();
        this.wakeSleep = null;
    }
}

// ---------------------------------------------------------------------------
// payload builders — each mirrors the matching samplePayload shape in
// lib/integrations.ts exactly (all scalars strings); the shape seeds designer
// test runs and the extract path picker, so it must not drift.
// ---------------------------------------------------------------------------

function build(
    ev: GithubEvent,
    fallbackRepo: string,
): { event: string; payload: Record<string, unknown> } | null {
    const repo = asStr(ev.repo?.name) || fallbackRepo;
    const timestamp = asStr(ev.created_at);
    const actor = asStr(ev.actor?.login);
    const p = asObj(ev.payload);
    const action = asStr(p.action);
    switch (ev.type) {
        case "PushEvent":
            return { event: "github-push", payload: buildPush(repo, timestamp, actor, p) };
        case "IssuesEvent":
            return action === "opened"
                ? { event: "github-issue", payload: buildIssue(repo, timestamp, p) }
                : null;
        case "PullRequestEvent":
            return action === "opened"
                ? { event: "github-pr", payload: buildPr(repo, timestamp, p) }
                : null;
        case "ReleaseEvent":
            return action === "published"
                ? { event: "github-release", payload: buildRelease(repo, timestamp, p) }
                : null;
        case "WatchEvent":
            return action === "started"
                ? { event: "github-star", payload: { repo, user: actor, timestamp } }
                : null;
        default:
            return null; // unknown event type — skipped silently
    }
}

function buildPush(
    repo: string,
    timestamp: string,
    pusher: string,
    p: Record<string, unknown>,
): Record<string, unknown> {
    const ref = asStr(p.ref);
    // branch filter targets refs/heads/*; tag pushes (refs/tags/*) get branch ""
    const branch = ref.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : "";
    const commits = asArr(p.commits);
    const head = asStr(p.head);
    const before = asStr(p.before);
    return {
        repo,
        ref,
        branch,
        pusher,
        // the Events API push payload usually omits size/commits — these are
        // initial guesses that enrichPush overwrites via the compare API;
        // zero-commit/force pushes report "0"
        commitCount: String(typeof p.size === "number" ? p.size : commits.length),
        headSha: head,
        beforeSha: before,
        messages: commits
            .slice(0, MAX_COMMIT_MESSAGES)
            .map((c) => asStr(asObj(c).message).slice(0, MAX_COMMIT_MESSAGE_CHARS)),
        // no compare url when either endpoint is missing
        compareUrl:
            before && head ? `https://github.com/${repo}/compare/${before}...${head}` : "",
        timestamp,
    };
}

function buildIssue(
    repo: string,
    timestamp: string,
    p: Record<string, unknown>,
): Record<string, unknown> {
    const issue = asObj(p.issue);
    return {
        repo,
        number: numStr(issue.number),
        title: asStr(issue.title),
        body: asStr(issue.body).slice(0, MAX_BODY_CHARS),
        author: asStr(asObj(issue.user).login),
        labels: asArr(issue.labels)
            .map((l) => asStr(asObj(l).name))
            .filter((n) => n),
        url: asStr(issue.html_url),
        timestamp,
    };
}

function buildPr(
    repo: string,
    timestamp: string,
    p: Record<string, unknown>,
): Record<string, unknown> {
    const pr = asObj(p.pull_request);
    return {
        repo,
        number: numStr(pr.number),
        title: asStr(pr.title),
        body: asStr(pr.body).slice(0, MAX_BODY_CHARS),
        author: asStr(asObj(pr.user).login),
        sourceBranch: asStr(asObj(pr.head).ref),
        targetBranch: asStr(asObj(pr.base).ref),
        draft: pr.draft ? "true" : "false",
        url: asStr(pr.html_url),
        timestamp,
    };
}

function buildRelease(
    repo: string,
    timestamp: string,
    p: Record<string, unknown>,
): Record<string, unknown> {
    const rel = asObj(p.release);
    return {
        repo,
        tag: asStr(rel.tag_name),
        name: asStr(rel.name),
        body: asStr(rel.body).slice(0, MAX_BODY_CHARS),
        author: asStr(asObj(rel.author).login),
        prerelease: rel.prerelease ? "true" : "false",
        url: asStr(rel.html_url),
        timestamp,
    };
}

async function poll() {
    let subs: EventSubscription[];
    try {
        subs = (await getEventSubscriptions()).filter((s) => s.provider === "github");
    } catch (err) {
        // transient DB unavailability must not tear down live pollers — keep
        // the current set
        console.error(`[github] subscription query failed: ${(err as Error).message}`);
        return;
    }

    // group by (token, repo). The key lower-cases the repo so casing variants
    // share one poller; the group keeps the first sub's casing for the URL.
    const byKey = new Map<string, { token: string; repo: string; subs: EventSubscription[] }>();
    for (const sub of subs) {
        const repo = (sub.config.repo ?? "").trim();
        if (!validRepo(repo)) {
            console.warn(
                `[github] skipping subscription for workflow ${sub.workflowId}: invalid repository "${repo}"`,
            );
            continue;
        }
        const token = sub.botToken;
        // never poll with a malformed token (e.g. a deleted-variable sentinel
        // left literal in the optional field)
        if (token && !TOKEN_RE.test(token)) {
            console.warn(
                `[github ${repo}] skipping subscription for workflow ${sub.workflowId}: malformed access token`,
            );
            continue;
        }
        const key = `${token}\n${repo.toLowerCase()}`;
        const group = byKey.get(key);
        if (group) group.subs.push(sub);
        else byKey.set(key, { token, repo, subs: [sub] });
    }

    for (const [key, poller] of pollers) {
        const wanted = byKey.get(key);
        if (wanted) {
            // loop survives filter/workflow edits; a dead (401) poller stays in
            // the map as a tombstone here so it isn't respawned each reconcile
            poller.subs = wanted.subs;
        } else {
            console.log(`[github ${poller.tag()}] no subscriptions left, stopping poller`);
            poller.destroy();
            pollers.delete(key);
        }
    }
    for (const [key, group] of byKey) {
        if (!pollers.has(key)) {
            console.log(
                `[github ${group.repo}${group.token ? ` ${fp(group.token)}` : ""}] starting poller (${group.subs.length} subscription${group.subs.length === 1 ? "" : "s"})`,
            );
            pollers.set(key, new GithubRepoPoller(key, group.token, group.repo, group.subs));
        }
    }
}

export function startGithub() {
    stopped = false;
    // push invalidation from workflow mutations — debounced so designer
    // autosave bursts collapse to one re-poll
    unsubscribe = onSubscriptionsChanged(() => {
        if (stopped || refreshTimer) return;
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            void poll();
        }, REFRESH_DEBOUNCE_MS);
    });
    // the interval poll stays as the reconciliation backstop
    const loop = async () => {
        await poll();
        if (!stopped) {
            pollTimer = setTimeout(loop, POLL_INTERVAL_MS);
            pollTimer.unref();
        }
    };
    console.log(`[github] started (reconcile every ${POLL_INTERVAL_MS / 1_000}s)`);
    void loop();
}

export function stopGithub() {
    stopped = true;
    unsubscribe?.();
    unsubscribe = null;
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
    if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
    }
    for (const poller of pollers.values()) poller.destroy();
    pollers.clear();
}
