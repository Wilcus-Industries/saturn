// Persistent per-user linux sandbox core (server-only). A sandbox is a
// registry_entry of kind 'sandbox'; its filesystem lives in a podman named
// volume `sb-<entryUuid>` mounted at /work, and a container `sb-<entryUuid>`
// (booted on demand, idle-stopped after 5 min) is exec'd into. Agents get
// three tools at runtime — sandbox_exec / sandbox_write_file /
// sandbox_read_file — resolved to AgentToolSpecs like MCP or memory tools,
// but executed here against the local podman socket instead of an external
// server. This mirrors lib/memory.server.ts structure/conventions: all
// failures return as values — never throw for an expected failure.
//
// Concurrency/lifecycle state (running set, LRU, disk usage) is kept in
// in-process Maps; that is correct only under the single-process deployment
// invariant documented in CLAUDE.md (same assumption as lib/cache.server.ts).
import { type McpCallResult, SANDBOX_TOOL_NAMES } from "@/lib/agent";
import type { AgentToolSpec } from "@/lib/agent.server";
import {
    assertContainerHardened,
    createContainer,
    createVolume,
    execInContainer,
    imageExists,
    inspectContainer,
    listSandboxContainers,
    podmanConfigured,
    removeContainer,
    removeVolume,
    startContainer,
    stopContainer,
} from "@/lib/podman.server";
import { getUserRegistry } from "@/lib/registry.server";
import { getActivationLevels, limitsFor } from "@/lib/subscription";
import type { McpToolParam } from "@/lib/workflow";
import { posix } from "node:path";

export const SANDBOX_MAX_RUNNING = 2; // global cap on concurrently-running sandboxes (Pi capacity)
export const SANDBOX_IDLE_STOP_MS = 300_000; // stop a sandbox 5 min after its last op
export const MAX_SANDBOX_OUTPUT = 24_000; // chars of merged stdout+stderr fed back
export const SANDBOX_IMAGE = "saturn-sandbox:latest";

const SANDBOX_PIDS_LIMIT = 256; // fork-bomb guard, same for every tier
const MAX_SANDBOX_WRITE_B64 = 96_000; // max base64 length of one sandbox_write_file argv (well under Linux MAX_ARG_STRLEN ~128KB)
const REAPER_INTERVAL_MS = 60_000;
const DISK_CHECK_TIMEOUT_MS = 15_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const [SANDBOX_EXEC, SANDBOX_WRITE, SANDBOX_READ] = SANDBOX_TOOL_NAMES;

// container and volume share the name — one persistent volume per sandbox,
// one container recreated over it
const containerName = (uuid: string) => `sb-${uuid}`;
const volumeName = (uuid: string) => `sb-${uuid}`;

// in-process lifecycle state (single-process invariant):
//   lastUsed   — container name → epoch ms of its last op (LRU eviction + reaper)
//   diskUsage  — sandbox uuid → last-known `du -sm /work` MB (advisory quota)
//   inFlight   — container name → count of execs running right now (ref-counted
//                so an op + its disk refresh balance): makeRoom must never evict
//                and the reaper must never stop a container mid-exec, and lastUsed
//                is stamped only at op START, so a long exec (up to the max tier's
//                300s cap == SANDBOX_IDLE_STOP_MS) would otherwise look idle.
const lastUsed = new Map<string, number>();
const diskUsage = new Map<string, number>();
const inFlight = new Map<string, number>();

function isBusy(name: string): boolean {
    return (inFlight.get(name) ?? 0) > 0;
}

// runs an exec while marking the container busy, and re-stamps lastUsed on
// COMPLETION too (not just at op start) so a long-running command keeps the
// container off the LRU/reaper chopping block until it actually finishes.
async function execTracked(
    name: string,
    cmd: string[],
    opts: { timeoutMs: number; maxOutput: number },
): Promise<{ exitCode: number | null; output: string; truncated: boolean }> {
    inFlight.set(name, (inFlight.get(name) ?? 0) + 1);
    try {
        return await execInContainer(name, cmd, opts);
    } finally {
        const n = (inFlight.get(name) ?? 0) - 1;
        if (n <= 0) inFlight.delete(name);
        else inFlight.set(name, n);
        lastUsed.set(name, Date.now());
    }
}

// ------------------------------------------------------------------ tool specs

// the three tools an agent gets from one attached sandbox node. Each ref
// carries the sandbox id as entryId (mirrors an MCP/memory tool ref); the
// runner dispatches by toolName into executeSandboxTool.
export function sandboxToolSpecs(sandboxId: string): AgentToolSpec[] {
    return [
        {
            ref: { entryId: sandboxId, toolName: SANDBOX_EXEC },
            description:
                "Run a bash command in a persistent Debian linux sandbox. /work persists across runs; stdout and stderr are returned together (capped), and nonzero exit codes are reported.",
            params: [
                {
                    name: "command",
                    type: "string",
                    required: true,
                    description: "bash command run inside the sandbox",
                },
                {
                    name: "timeout",
                    type: "number",
                    required: false,
                    description: "seconds, capped by plan tier",
                },
            ] satisfies McpToolParam[],
        },
        {
            ref: { entryId: sandboxId, toolName: SANDBOX_WRITE },
            description:
                "Write a text file inside the sandbox under /work (persists across runs). Parent directories are created as needed; an existing file is overwritten.",
            params: [
                {
                    name: "path",
                    type: "string",
                    required: true,
                    description: "path under /work",
                },
                {
                    name: "content",
                    type: "string",
                    required: true,
                    description: "file contents to write",
                },
            ] satisfies McpToolParam[],
        },
        {
            ref: { entryId: sandboxId, toolName: SANDBOX_READ },
            description: "Read a text file from the sandbox under /work.",
            params: [
                {
                    name: "path",
                    type: "string",
                    required: true,
                    description: "path under /work",
                },
            ] satisfies McpToolParam[],
        },
    ];
}

// ------------------------------------------------------------------- executor

type TierLimits = ReturnType<typeof limitsFor>;

// executes one sandbox tool call for a workflow run. Errors return as values
// (not throws) so consoles and run logs can render them — same contract as
// executeMcpTool / executeMemoryTool.
export async function executeSandboxTool(
    userId: string,
    sandboxId: string,
    op: string,
    input: string,
): Promise<McpCallResult> {
    if (typeof sandboxId !== "string" || !UUID.test(sandboxId)) {
        return { error: "invalid sandbox id" };
    }
    if (typeof op !== "string" || !(SANDBOX_TOOL_NAMES as readonly string[]).includes(op)) {
        return { error: "unknown sandbox operation" };
    }

    // 1. runtime configured?
    if (!podmanConfigured()) return { error: "sandbox runtime not configured" };

    // 2. ownership — the sandbox must be one of this user's registry entries
    const registry = await getUserRegistry(userId);
    const row = registry.find((r) => r.id === sandboxId && r.kind === "sandbox");
    if (!row) return { error: "sandbox not found" };

    // parse the model-built argument object — same convention as executeMcpTool
    let args: Record<string, unknown> = {};
    if (typeof input === "string" && input.trim()) {
        try {
            const parsed: unknown = JSON.parse(input);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
                throw new Error();
            }
            args = parsed as Record<string, unknown>;
        } catch {
            return { error: 'input must be a JSON object, e.g. {"command":"..."}' };
        }
    }

    // 3. tier quotas (memory/cpu/disk/exec-timeout) — headless resolver, same
    // as the cron runner; a not-activated user maps to free limits.
    const level = (await getActivationLevels([userId])).get(userId) ?? null;
    const limits = limitsFor(level);

    try {
        // 4. ensure the container exists and is running (serialized per sandbox)
        const ensured = await ensureRunning(sandboxId, limits);
        if (ensured) return ensured;

        // 5. advisory disk quota: reject up-front if the last known usage is
        // already over the tier cap. This is intentionally best-effort — see
        // the du refresh after each op below.
        const known = diskUsage.get(sandboxId);
        if (typeof known === "number" && known > limits.sandboxDiskMb) {
            return {
                error: `sandbox disk quota exceeded (${known}/${limits.sandboxDiskMb} MB) — reset it from the Sandboxes dashboard`,
            };
        }

        // 6. dispatch
        if (op === SANDBOX_EXEC) return await sandboxExec(sandboxId, limits, args);
        if (op === SANDBOX_WRITE) return await sandboxWriteFile(sandboxId, args);
        return await sandboxReadFile(sandboxId, args);
    } catch (err) {
        // PodmanError carries a user-renderable message; anything else falls
        // back generic. Never throw out of a tool call.
        return { error: err instanceof Error ? err.message : "sandbox operation failed" };
    }
}

// --------------------------------------------------------------------- ops

async function sandboxExec(
    uuid: string,
    limits: TierLimits,
    args: Record<string, unknown>,
): Promise<McpCallResult> {
    const command = typeof args.command === "string" ? args.command : "";
    if (!command.trim()) return { error: "command must be a non-empty string" };

    // clamp the requested timeout into [1, tierCap]; default to the cap
    const cap = limits.sandboxExecTimeoutS;
    const requested =
        typeof args.timeout === "number" && Number.isFinite(args.timeout)
            ? Math.floor(args.timeout)
            : cap;
    const t = Math.max(1, Math.min(cap, requested));

    // the command string is NEVER shell-interpreted on the host — it rides as
    // a single argv element into an in-container `timeout … bash -lc <command>`.
    // The in-container `timeout` wrapper is the real wall-clock kill; the
    // socket timeout is only a backstop for an unresponsive container.
    const cmd = ["/usr/bin/timeout", "--signal=KILL", `${t}s`, "/bin/bash", "-lc", command];
    const { exitCode, output, truncated } = await execTracked(containerName(uuid), cmd, {
        timeoutMs: t * 1000 + 10_000,
        maxOutput: MAX_SANDBOX_OUTPUT,
    });
    await refreshDisk(uuid);

    let text = output;
    if (truncated) {
        // the socket was cut mid-command, so exitCode is unknown — say so
        // explicitly and never fall through to the "[exit code 0]" clean path
        text += "\n… [output truncated; exit status unknown]";
    } else if (exitCode !== 0) {
        text += `\n[exit code ${exitCode}]`;
        // 137 = 128 + SIGKILL(9): our `timeout --signal=KILL` firing, or the
        // OOM killer reaping the process against the memory cgroup cap
        if (exitCode === 137) {
            text += `\n(killed — likely timed out after ${t}s or out of memory)`;
        }
    }
    return { text: text || "(no output)" };
}

async function sandboxWriteFile(
    uuid: string,
    args: Record<string, unknown>,
): Promise<McpCallResult> {
    if (typeof args.content !== "string") return { error: "content must be a string" };
    const content = args.content;

    // base64-encode the content so arbitrary bytes (quotes, newlines, NULs)
    // survive the shell round-trip. This is safe from injection because the
    // base64 alphabet contains no single-quote, and confinePath has already
    // rejected any single-quote in the path — so neither substituted value can
    // break out of its single-quoted context. Parent dir is created first.
    const b64 = Buffer.from(content, "utf8").toString("base64");

    // The base64 blob ships as ONE argv element to `echo`, so the real limit is
    // Linux MAX_ARG_STRLEN (~128KB) — cap the ENCODED byte length (not the char
    // count: multibyte content is up to 4 bytes/char and would blow past the
    // argv limit while still under a char cap, triggering E2BIG).
    if (b64.length > MAX_SANDBOX_WRITE_B64) {
        return {
            error: "content too large — write in chunks or use sandbox_exec with a heredoc",
        };
    }
    const path = confinePath(typeof args.path === "string" ? args.path : "");
    if (!path) return { error: "invalid path — must resolve under /work" };
    const dir = posix.dirname(path);

    const script = `mkdir -p '${dir}' && echo '${b64}' | base64 -d > '${path}'`;
    const { exitCode, output } = await execTracked(
        containerName(uuid),
        ["/bin/bash", "-c", script],
        { timeoutMs: 30_000, maxOutput: 4_000 },
    );
    await refreshDisk(uuid);

    if (exitCode !== 0) {
        const detail = output.trim();
        // exitCode null (a truncated write → unknown) lands here too as a
        // failure, the safe default for a write
        const code = exitCode === null ? "unknown" : exitCode;
        return {
            error: `write failed${detail ? `: ${detail.slice(0, 500)}` : ` (exit ${code})`}`,
        };
    }
    return {
        text: JSON.stringify({ path, bytes: Buffer.byteLength(content, "utf8"), written: true }),
    };
}

async function sandboxReadFile(
    uuid: string,
    args: Record<string, unknown>,
): Promise<McpCallResult> {
    const path = confinePath(typeof args.path === "string" ? args.path : "");
    if (!path) return { error: "invalid path — must resolve under /work" };

    // `--` so a path that (despite confinement) begins with '-' is never read
    // as a cat flag
    const { exitCode, output, truncated } = await execTracked(
        containerName(uuid),
        ["/bin/cat", "--", path],
        { timeoutMs: 30_000, maxOutput: MAX_SANDBOX_OUTPUT },
    );
    // a truncated read is a large-but-readable file, not a failure — its
    // exitCode is unknown (null), so only treat a definite nonzero exit on a
    // complete read as an error
    if (!truncated && exitCode !== 0) {
        const detail = output.trim();
        return {
            error: `could not read ${path}${detail ? `: ${detail.slice(0, 500)}` : ` (exit ${exitCode})`}`,
        };
    }
    let text = output;
    if (truncated) text += "\n… (output truncated)";
    return { text };
}

// ------------------------------------------------------------- path confinement

// validates and normalizes a caller path into an absolute path guaranteed to
// live under /work — returns null on any violation. Rejects empty/NUL and
// single-quote chars (the latter is what keeps the shell substitution above
// injection-safe), posix-normalizes, and rejects any surviving ".." segment.
// A relative path is rooted at /work; an absolute path must already be under
// /work.
export function confinePath(p: string): string | null {
    if (typeof p !== "string" || p === "") return null;
    if (p.includes("\0") || p.includes("'")) return null;

    const norm = posix.normalize(p);
    if (norm.split("/").some((seg) => seg === "..")) return null;

    const abs = norm.startsWith("/") ? norm : posix.normalize(`/work/${norm}`);
    // re-check after rooting — normalize can't turn a leading ".." absolute,
    // and we already rejected those, but stay defensive
    if (abs.split("/").some((seg) => seg === "..")) return null;
    if (abs !== "/work" && !abs.startsWith("/work/")) return null;
    return abs;
}

// ------------------------------------------------------------- ensure running

// per-sandbox promise-chain mutex: two concurrent tool calls on the same
// sandbox must not both try to create/start it. Keyed by uuid; the chain's
// tail is stored settled-swallowing so a failure never poisons the next
// waiter, and the map entry is dropped once its chain drains.
const ensureLocks = new Map<string, Promise<unknown>>();

function withEnsureLock<T>(uuid: string, fn: () => Promise<T>): Promise<T> {
    const prev = ensureLocks.get(uuid) ?? Promise.resolve();
    const run = prev.then(fn, fn); // run regardless of the previous op's outcome
    const tail = run.then(
        () => undefined,
        () => undefined,
    );
    ensureLocks.set(uuid, tail);
    void tail.finally(() => {
        if (ensureLocks.get(uuid) === tail) ensureLocks.delete(uuid);
    });
    return run;
}

// single GLOBAL boot mutex — serializes the makeRoom→count→evict→create→start
// critical section across ALL sandboxes. SANDBOX_MAX_RUNNING is enforced by
// makeRoom OUTSIDE any per-uuid lock, so two concurrent tool calls on DIFFERENT
// sandboxes would each see others<cap and both start → over-cap on the Pi. This
// chain (same self-cleaning promise-chain shape as withEnsureLock, but a single
// shared key) lets only one sandbox boot at a time. It is acquired ONCE per boot
// branch and never while already held for the same path, so it can't deadlock.
let bootLock: Promise<unknown> = Promise.resolve();

function withBootLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = bootLock.then(fn, fn);
    bootLock = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

// ensures the sandbox container exists and is running, creating the volume +
// container on first use. Returns an error-value to short-circuit (image
// missing / too many running); null on success. Podman failures throw and are
// caught by executeSandboxTool. Stamps lastUsed on success (every op).
//
// Note: an existing container keeps the resource limits it was created with —
// a tier change takes effect only after the sandbox is reset/recreated. That
// tradeoff is accepted (recreation is a dashboard action).
async function ensureRunning(
    uuid: string,
    limits: TierLimits,
): Promise<McpCallResult | null> {
    return withEnsureLock(uuid, async () => {
        const name = containerName(uuid);
        const state = await inspectContainer(name);

        if (state === null) {
            // first use: image must be present, then make room, create, start
            if (!(await imageExists(SANDBOX_IMAGE))) {
                return { error: "sandbox image not installed on the server" };
            }
            // the whole make-room→create→start section runs under the global
            // boot mutex so the running-count can't be read stale by a
            // concurrent boot of a different sandbox (FIX: TOCTOU on the cap).
            const booted = await withBootLock(async () => {
                const noRoom = await makeRoom(name);
                if (noRoom) return noRoom;
                await createVolume(volumeName(uuid));
                await createContainer({
                    name,
                    image: SANDBOX_IMAGE,
                    volumeName: volumeName(uuid),
                    memoryBytes: limits.sandboxMemoryMb * 1024 * 1024,
                    cpus: limits.sandboxCpus,
                    pidsLimit: SANDBOX_PIDS_LIMIT,
                });
                // verify the containment controls actually took BEFORE starting
                // it — podman silently drops renamed SpecGenerator keys, so a
                // version skew would otherwise boot an unconfined container. A
                // failed assertion means this podman is incompatible: stop+
                // remove the unsafe container, log loudly, and surface {error}.
                try {
                    await assertContainerHardened(name);
                } catch (err) {
                    console.error(
                        "[sandbox] containment assertion failed — refusing to start; podman version is incompatible with the SpecGenerator schema",
                        err,
                    );
                    await stopContainer(name).catch(() => {});
                    await removeContainer(name).catch(() => {});
                    throw err;
                }
                await startContainer(name);
                return null;
            });
            if (booted) return booted;
        } else if (!state.running) {
            const booted = await withBootLock(async () => {
                const noRoom = await makeRoom(name);
                if (noRoom) return noRoom;
                await startContainer(name);
                return null;
            });
            if (booted) return booted;
        }

        lastUsed.set(name, Date.now());
        return null;
    });
}

// enforces SANDBOX_MAX_RUNNING before we start `selfName`: if that many OTHER
// sandboxes are already running, stop the least-recently-used one (unknown
// lastUsed treated as oldest). If still over after eviction, return an
// error-value asking the caller to retry.
async function makeRoom(selfName: string): Promise<McpCallResult | null> {
    const others = (await listSandboxContainers()).filter(
        (c) => c.running && c.name !== selfName,
    );
    if (others.length < SANDBOX_MAX_RUNNING) return null;

    // never evict a container with an exec in flight — pick the LRU victim from
    // the idle ones only. If every running sandbox is mid-exec there is no safe
    // room to make, so ask the caller to retry rather than kill a live command.
    const lru = others
        .filter((c) => !isBusy(c.name))
        .map((c) => ({ name: c.name, at: lastUsed.get(c.name) ?? 0 }))
        .sort((a, b) => a.at - b.at)[0];
    if (!lru) {
        return { error: "too many sandboxes running — try again shortly" };
    }
    await stopContainer(lru.name);
    lastUsed.delete(lru.name);

    const still = (await listSandboxContainers()).filter(
        (c) => c.running && c.name !== selfName,
    );
    if (still.length >= SANDBOX_MAX_RUNNING) {
        return { error: "too many sandboxes running — try again shortly" };
    }
    return null;
}

// refreshes the advisory disk-usage map after a write/exec. Fire-and-forget
// semantics: a failure just leaves the stale value.
//
// Accepted tradeoff: a single exec can overshoot the quota before this
// post-check records it — recovery is a dashboard reset. (v2 alternative: when
// over quota, still permit read-only / rm-only ops so the agent can free space
// itself instead of forcing a reset.)
async function refreshDisk(uuid: string): Promise<void> {
    try {
        const { output } = await execTracked(
            containerName(uuid),
            ["/usr/bin/du", "-sm", "/work"],
            { timeoutMs: DISK_CHECK_TIMEOUT_MS, maxOutput: 200 },
        );
        const m = /^(\d+)/.exec(output.trim());
        if (m) diskUsage.set(uuid, parseInt(m[1], 10));
    } catch {
        // best-effort — keep the last-known value
    }
}

// ------------------------------------------------------------- dashboard views

// status for each sandbox entry (running + last-known disk MB) for the
// Sandboxes dashboard. When podman isn't configured every entry reports
// configured:false so the UI can explain sandboxes are unavailable.
export async function getSandboxStatuses(
    entryIds: string[],
): Promise<Map<string, { running: boolean; diskMb: number | null; configured: boolean }>> {
    const result = new Map<string, { running: boolean; diskMb: number | null; configured: boolean }>();
    if (!podmanConfigured()) {
        for (const id of entryIds) result.set(id, { running: false, diskMb: null, configured: false });
        return result;
    }

    const running = new Set<string>();
    try {
        for (const c of await listSandboxContainers()) {
            if (c.running) running.add(c.name);
        }
    } catch {
        // podman unreachable — report everything as stopped rather than error
    }
    for (const id of entryIds) {
        result.set(id, {
            running: running.has(containerName(id)),
            diskMb: diskUsage.has(id) ? (diskUsage.get(id) ?? null) : null,
            configured: true,
        });
    }
    return result;
}

// -------------------------------------------------------------- lifecycle ops

// fully removes a sandbox (container + persistent volume) — for entry
// deletion. Best-effort: every step is caught, never throws.
export async function destroySandbox(uuid: string): Promise<void> {
    const name = containerName(uuid);
    try {
        await stopContainer(name);
        await removeContainer(name);
        await removeVolume(volumeName(uuid));
    } catch (err) {
        console.error("[sandbox] destroy failed", err);
    }
    lastUsed.delete(name);
    diskUsage.delete(uuid);
}

// wipes a sandbox back to empty: removes the container AND its volume (the
// volume is recreated lazily on next use), clearing the disk-usage entry.
// Unlike destroy, returns an {error?} value so the dashboard can surface a
// failure to the user.
export async function resetSandbox(uuid: string): Promise<{ error?: string }> {
    const name = containerName(uuid);
    try {
        await stopContainer(name);
        await removeContainer(name);
        await removeVolume(volumeName(uuid));
        lastUsed.delete(name);
        diskUsage.delete(uuid);
        return {};
    } catch (err) {
        console.error("[sandbox] reset failed", err);
        return { error: err instanceof Error ? err.message : "sandbox reset failed" };
    }
}

// stops a sandbox now (dashboard "stop" button) — best-effort, never throws.
export async function stopSandboxNow(uuid: string): Promise<void> {
    try {
        await stopContainer(containerName(uuid));
        lastUsed.delete(containerName(uuid));
    } catch (err) {
        console.error("[sandbox] stop failed", err);
    }
}

// ------------------------------------------------------------------ reaper

// idle reaper — stops sandboxes idle longer than SANDBOX_IDLE_STOP_MS. Started
// from lib/background.server.ts on production boot alongside the scheduler /
// gateway / telegram poller. Matches their start/stop shape: a 60s
// setInterval (.unref()), guarded against double-start, no-op when podman
// isn't configured.
let reaperTimer: NodeJS.Timeout | null = null;

export function startSandboxReaper() {
    if (reaperTimer || !podmanConfigured()) return;
    reaperTimer = setInterval(() => void reapTick(), REAPER_INTERVAL_MS);
    reaperTimer.unref();
    console.log("[sandbox] idle reaper started");
}

export function stopSandboxReaper() {
    if (reaperTimer) {
        clearInterval(reaperTimer);
        reaperTimer = null;
    }
}

async function reapTick(): Promise<void> {
    try {
        const now = Date.now();
        for (const c of await listSandboxContainers()) {
            if (!c.running) continue;
            if (isBusy(c.name)) continue; // exec in flight — never stop mid-run
            let at = lastUsed.get(c.name);
            if (at === undefined) {
                // container running but unknown to us (app restart) — adopt it
                // now so it gets a full idle window before being reaped
                lastUsed.set(c.name, now);
                at = now;
            }
            if (now - at > SANDBOX_IDLE_STOP_MS) {
                try {
                    await stopContainer(c.name);
                    lastUsed.delete(c.name);
                } catch (err) {
                    console.error("[sandbox] reaper stop failed", err);
                }
            }
        }
    } catch (err) {
        // never throw out of the interval callback
        console.error("[sandbox] reaper tick failed", err);
    }
}
