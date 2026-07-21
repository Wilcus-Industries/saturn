import "server-only";
// Minimal rootless-Podman libpod (v4.x) REST client over a unix socket —
// the runtime substrate for per-user linux sandboxes (lib/sandbox.server.ts).
//
// The Next.js process drives Podman's libpod API directly over the socket at
// SANDBOX_PODMAN_SOCKET (read lazily per call so an unset env simply disables
// sandboxes). NO child_process anywhere, NO new npm dependency — every call is
// a raw node:http request({ socketPath }) against the libpod HTTP API.
//
// Field names below target podman 4.x libpod (the SpecGenerator create body,
// the exec multiplexed frame protocol, the /json inspect shapes). Verify them
// against the Pi's actual podman before trusting — e.g.:
//   curl --unix-socket "$SANDBOX_PODMAN_SOCKET" http://d/v4.0.0/libpod/_ping
// (see deploy/sandboxes.md). A version skew shows up as a create 4xx/5xx with
// a body snippet on the thrown PodmanError.
import http from "node:http";
import { StringDecoder } from "node:string_decoder";

const API = "/v4.0.0/libpod";
const DEFAULT_TIMEOUT_MS = 15_000;

// lazily-read socket path — unset means "sandboxes disabled" everywhere
function socketPath(): string | null {
    return process.env.SANDBOX_PODMAN_SOCKET || null;
}

export function podmanConfigured(): boolean {
    return !!socketPath();
}

// thrown on any unexpected libpod status; carries the HTTP status + a body
// snippet so callers (sandbox.server.ts) can turn it into an error-value.
export class PodmanError extends Error {
    status: number;
    constructor(status: number, message: string) {
        super(message);
        this.name = "PodmanError";
        this.status = status;
    }
}

function fail(op: string, status: number, body: string): never {
    throw new PodmanError(status, `podman ${op} failed (${status}): ${body.slice(0, 300)}`);
}

// ------------------------------------------------------------- low-level HTTP

// one buffered libpod request. Rejects with a PodmanError on socket/timeout
// failure; resolves with the raw status + body for the caller to interpret
// (many endpoints use 204/304/404 as meaningful "already in that state").
function req(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ status: number; body: string }> {
    const socket = socketPath();
    if (!socket) return Promise.reject(new PodmanError(0, "podman socket not configured"));
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        let settled = false;
        const r = http.request(
            {
                socketPath: socket,
                method,
                path,
                headers: payload
                    ? {
                          "content-type": "application/json",
                          "content-length": Buffer.byteLength(payload),
                      }
                    : {},
                timeout: timeoutMs,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c: Buffer) => chunks.push(c));
                res.on("end", () => {
                    if (settled) return;
                    settled = true;
                    resolve({
                        status: res.statusCode ?? 0,
                        body: Buffer.concat(chunks).toString("utf8"),
                    });
                });
            },
        );
        r.on("timeout", () => r.destroy(new PodmanError(0, "podman request timed out")));
        r.on("error", (err) => {
            if (settled) return;
            settled = true;
            reject(
                err instanceof PodmanError
                    ? err
                    : new PodmanError(0, `podman socket error: ${err.message}`),
            );
        });
        if (payload) r.write(payload);
        r.end();
    });
}

// ------------------------------------------------------------------- images

// GET .../images/{ref}/exists → 204 exists, 404 missing. ref is a controlled
// constant (SANDBOX_IMAGE), so the tag colon is passed through unencoded.
export async function imageExists(ref: string): Promise<boolean> {
    const { status, body } = await req("GET", `${API}/images/${ref}/exists`);
    if (status === 204) return true;
    if (status === 404) return false;
    fail("image exists", status, body);
}

// ------------------------------------------------------------------ volumes

// POST .../volumes/create {Name}. libpod returns 201 with the volume config;
// an already-existing volume may come back 409 or a 500 whose body says so —
// both are fine (the named volume is the whole point of persistence).
export async function createVolume(name: string): Promise<void> {
    const { status, body } = await req("POST", `${API}/volumes/create`, { Name: name });
    if (status === 200 || status === 201 || status === 409) return;
    if (/exist/i.test(body)) return; // "volume already exists" under some versions
    fail("create volume", status, body);
}

// DELETE .../volumes/{name}?force=true — 404 is fine (already gone)
export async function removeVolume(name: string): Promise<void> {
    const { status, body } = await req(
        "DELETE",
        `${API}/volumes/${encodeURIComponent(name)}?force=true`,
    );
    if (status === 200 || status === 204 || status === 404) return;
    fail("remove volume", status, body);
}

// ---------------------------------------------------------------- containers

// narrow, caller-supplied create input — everything security-relevant is fixed
// below, only the resource sizing and identity vary per sandbox/tier.
export type ContainerSpecInput = {
    name: string;
    image: string;
    volumeName: string;
    memoryBytes: number;
    cpus: number;
    pidsLimit: number;
};

// POST .../containers/create with a libpod SpecGenerator body (NOT the
// docker-compat schema).
//
// SECURITY INVARIANTS — this is untrusted-code containment; do not relax:
//   - explicit env ONLY ({PATH, HOME=/work, LANG}); env_host:false so the
//     Next.js process environment (DB URL, API keys, Stripe secrets…) NEVER
//     leaks into the sandbox.
//   - user "1000:1000" — the image's non-root `sandbox` user, never root.
//   - the named volume {Name, Dest:/work} is the ONLY persistent mount; the
//     sole other mount is a tmpfs /tmp. NO host bind mounts, ever.
//   - read_only_filesystem:true — the rootfs is immutable; only /work (volume)
//     and /tmp (tmpfs, size-capped 64m, exec allowed for pip/npm builds) are
//     writable.
//   - cap_drop:["ALL"] + no_new_privileges:true — no capabilities, no setuid
//     escalation.
//   - resource_limits caps memory, cpu (quota/period), and pids so one sandbox
//     can't starve the 4GB Pi or fork-bomb it.
//   - labels {saturn.sandbox:"1"} so listSandboxContainers/reaper can find our
//     containers and never touch anything else on the host.
//   - command ["sleep","infinity"] + restart_policy "no": the container is a
//     bare idle shell we exec into; it never restarts on its own.
export async function createContainer(spec: ContainerSpecInput): Promise<void> {
    const specGenerator = {
        name: spec.name,
        image: spec.image,
        command: ["sleep", "infinity"],
        user: "1000:1000",
        work_dir: "/work",
        // explicit env only — never the host process env
        env: {
            PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            HOME: "/work",
            LANG: "C.UTF-8",
        },
        env_host: false,
        httpproxy: false,
        terminal: false,
        stdin: false,
        remove: false,
        restart_policy: "no",
        labels: { "saturn.sandbox": "1" },
        cap_drop: ["ALL"],
        no_new_privileges: true,
        read_only_filesystem: true,
        volumes: [{ Name: spec.volumeName, Dest: "/work" }],
        mounts: [
            {
                Type: "tmpfs",
                Destination: "/tmp",
                // exec allowed on /tmp (omit noexec) — pip/npm build there
                Options: ["rw", "size=64m"],
            },
        ],
        resource_limits: {
            memory: { limit: spec.memoryBytes },
            cpu: { quota: Math.round(spec.cpus * 100_000), period: 100_000 },
            pids: { limit: spec.pidsLimit },
        },
    };
    const { status, body } = await req("POST", `${API}/containers/create`, specGenerator);
    if (status === 200 || status === 201) return;
    fail("create container", status, body);
}

// POST .../containers/{name}/start — 204 started, 304 already running
export async function startContainer(name: string): Promise<void> {
    const { status, body } = await req("POST", `${API}/containers/${name}/start`);
    if (status === 204 || status === 304) return;
    fail("start container", status, body);
}

// POST .../containers/{name}/stop?timeout=5 — 304 already stopped, 404 gone
export async function stopContainer(name: string): Promise<void> {
    const { status, body } = await req("POST", `${API}/containers/${name}/stop?timeout=5`);
    if (status === 204 || status === 304 || status === 404) return;
    fail("stop container", status, body);
}

// DELETE .../containers/{name}?force=true&v=false — force-kill-and-remove but
// keep the named volume (v=false) so /work survives a container recreate; 404
// is fine (already removed)
export async function removeContainer(name: string): Promise<void> {
    const { status, body } = await req(
        "DELETE",
        `${API}/containers/${name}?force=true&v=false`,
    );
    if (status === 200 || status === 204 || status === 404) return;
    fail("remove container", status, body);
}

// GET .../containers/{name}/json → null when 404, else {running} from
// .State.Running
export async function inspectContainer(name: string): Promise<{ running: boolean } | null> {
    const { status, body } = await req("GET", `${API}/containers/${name}/json`);
    if (status === 404) return null;
    if (status !== 200) fail("inspect container", status, body);
    let parsed: { State?: { Running?: boolean } };
    try {
        parsed = JSON.parse(body) as { State?: { Running?: boolean } };
    } catch {
        throw new PodmanError(status, "inspect container returned unreadable JSON");
    }
    return { running: parsed.State?.Running === true };
}

// Post-create containment audit — the single most important guard in this
// file. podman's Go json SILENTLY DROPS unknown SpecGenerator keys, so a field
// renamed across podman versions (env_host, cap_drop, no_new_privileges,
// read_only_filesystem…) is ignored: the container boots WITHOUT that
// containment control and create still returns a clean 201. So after create,
// before we ever start the container, we re-inspect and assert the critical
// invariants actually took. Any miss means this podman version is incompatible
// with the SpecGenerator schema and the container must never run — we throw
// PodmanError naming the failed invariant (the sandbox layer stops+removes the
// container, logs loudly, and surfaces an {error} value).
//
// Field names target libpod GET /containers/{name}/json (docker-compat shapes
// under /libpod): .HostConfig.ReadonlyRootfs (bool), .Config.User (string),
// .HostConfig.Binds ([]string host bind mounts), .Mounts ([]{Type,…}),
// .HostConfig.CapDrop / top-level .EffectiveCaps. ReadonlyRootfs and User are
// config-level and asserted strictly; the bind and cap checks fail loud on a
// present-and-wrong value but skip when the version omits the field
// (best-effort — we can't distinguish "absent because dropped" from "absent
// because renamed" for those).
export async function assertContainerHardened(name: string): Promise<void> {
    const { status, body } = await req("GET", `${API}/containers/${name}/json`);
    if (status !== 200) fail("inspect container (hardening)", status, body);
    let c: {
        Config?: { User?: string };
        HostConfig?: {
            ReadonlyRootfs?: boolean;
            Binds?: string[] | null;
            CapDrop?: string[] | null;
        };
        Mounts?: { Type?: string; Destination?: string }[];
        EffectiveCaps?: string[] | null;
    };
    try {
        c = JSON.parse(body) as typeof c;
    } catch {
        throw new PodmanError(status, "inspect container returned unreadable JSON");
    }

    const bad = (invariant: string): never => {
        throw new PodmanError(
            0,
            `sandbox hardening assertion failed: ${invariant} — podman version incompatible with the SpecGenerator schema`,
        );
    };

    // 1. immutable rootfs — read_only_filesystem must have taken.
    if (c.HostConfig?.ReadonlyRootfs !== true) bad("rootfs is not read-only");

    // 2. non-root — the image's uid 1000 ("1000" or "1000:1000"), never root
    //    or an empty (→ root) User.
    const user = c.Config?.User ?? "";
    if (!/^1000(:|$)/.test(user)) bad(`container user is "${user}", expected 1000`);

    // 3. no host bind mounts — only the named volume (/work) + tmpfs (/tmp)
    //    are allowed. HostConfig.Binds lists host-path binds, but some podman
    //    versions (5.4.x) also report named volumes there as
    //    "volumeName:/dest:opts" — only entries whose source is an absolute
    //    host path are real binds (volume names can't start with "/"). A
    //    "bind"-type entry in .Mounts is the same leak seen from the other
    //    side.
    const hostBinds = (c.HostConfig?.Binds ?? []).filter((b) => b.startsWith("/"));
    if (hostBinds.length > 0) {
        bad(`unexpected host bind mounts ${JSON.stringify(hostBinds)}`);
    }
    for (const m of c.Mounts ?? []) {
        if (m.Type === "bind") bad(`host bind mount present at ${m.Destination ?? "?"}`);
    }

    // 4. all capabilities dropped. cap_drop:["ALL"] surfaces in inspect either
    //    as the literal ["ALL"] or (podman 5.4.x) expanded to the full
    //    default-cap list — so any non-empty CapDrop means the field
    //    registered, while a silently-dropped/renamed key leaves CapDrop ===
    //    [] (verified against 5.4.2: with --cap-drop ALL it lists every
    //    default cap, without it it's []). EffectiveCaps is useless rootless:
    //    a non-root container reports null whether or not caps were dropped,
    //    so confirmed-empty [] stays a fallback but null proves nothing. We
    //    only fail on positive evidence — CapDrop present-and-empty with
    //    EffectiveCaps not confirmed empty — so a version that renames/omits
    //    both simply skips this leg.
    const capDrop = c.HostConfig?.CapDrop;
    const effective = c.EffectiveCaps;
    const dropRegistered = Array.isArray(capDrop) && capDrop.length > 0;
    const noEffective = Array.isArray(effective) && effective.length === 0;
    if (Array.isArray(capDrop) && !dropRegistered && !noEffective) {
        bad("cap_drop did not drop ALL capabilities");
    }
}

// GET .../containers/json?all=true&filters={"label":["saturn.sandbox=1"]} —
// only our labeled sandboxes are ever listed/reaped, never other host
// containers. Names arrive with a leading "/" on some versions; strip it.
export async function listSandboxContainers(): Promise<{ name: string; running: boolean }[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: ["saturn.sandbox=1"] }));
    const { status, body } = await req(
        "GET",
        `${API}/containers/json?all=true&filters=${filters}`,
    );
    if (status !== 200) fail("list containers", status, body);
    let rows: { Names?: string[]; State?: string }[];
    try {
        rows = JSON.parse(body) as { Names?: string[]; State?: string }[];
    } catch {
        throw new PodmanError(status, "list containers returned unreadable JSON");
    }
    const out: { name: string; running: boolean }[] = [];
    for (const row of rows) {
        const raw = Array.isArray(row.Names) ? row.Names[0] : undefined;
        if (!raw) continue;
        out.push({
            name: raw.startsWith("/") ? raw.slice(1) : raw,
            running: row.State === "running",
        });
    }
    return out;
}

// ---------------------------------------------------------------------- exec

// runs one command inside a running container, capturing merged stdout+stderr.
// The libpod exec endpoints use Docker-style capitalized keys even under
// /libpod. Two-step: create the exec, then start it (attached, non-detached).
//
// The /exec/{id}/start response is a MULTIPLEXED stream: each frame is an
// 8-byte header (byte 0 = stream type — 1 stdout, 2 stderr; bytes 4-7 =
// big-endian uint32 payload length) followed by that many payload bytes.
// Frames can split across TCP chunks, so partial frames are buffered. stdout
// and stderr are merged in arrival order into one string; collection stops at
// maxOutput chars (the socket is then destroyed and `truncated` set). The real
// wall-clock kill is the in-container `timeout` wrapper the caller prepends;
// timeoutMs here is only a socket backstop for an unresponsive container.
export async function execInContainer(
    container: string,
    cmd: string[],
    opts: { timeoutMs: number; maxOutput: number },
): Promise<{ exitCode: number | null; output: string; truncated: boolean }> {
    const create = await req("POST", `${API}/containers/${container}/exec`, {
        AttachStdout: true,
        AttachStderr: true,
        Cmd: cmd,
        WorkingDir: "/work",
        Env: [],
    });
    if (create.status !== 200 && create.status !== 201) {
        fail("exec create", create.status, create.body);
    }
    let id: string | undefined;
    try {
        id = (JSON.parse(create.body) as { Id?: string }).Id;
    } catch {
        throw new PodmanError(create.status, "exec create returned unreadable JSON");
    }
    if (!id) throw new PodmanError(create.status, "exec create returned no Id");

    const { output, truncated } = await execStart(id, opts);

    // Exit code lives on the exec inspect, available once the stream ends. But
    // when we TRUNCATED we destroyed the socket while the command was still
    // running, so the inspect's ExitCode is unreliable (typically null, which
    // must NOT be read as a clean 0 — a truncated FAILING command would then
    // look successful). Report exitCode null = "unknown" in that case and let
    // the caller phrase the result honestly.
    let exitCode: number | null;
    if (truncated) {
        exitCode = null;
    } else {
        exitCode = 0;
        const inspect = await req("GET", `${API}/exec/${id}/json`);
        if (inspect.status === 200) {
            try {
                const code = (JSON.parse(inspect.body) as { ExitCode?: number }).ExitCode;
                if (typeof code === "number") exitCode = code;
            } catch {
                // leave exitCode 0 — the output is still valid
            }
        }
    }
    return { exitCode, output, truncated };
}

// starts an exec and drains its multiplexed stream, de-framing on the fly and
// stopping early at maxOutput. Rejects with a PodmanError only on a socket
// error / backstop timeout (the caller converts that to an error-value).
function execStart(
    id: string,
    opts: { timeoutMs: number; maxOutput: number },
): Promise<{ output: string; truncated: boolean }> {
    const socket = socketPath();
    if (!socket) return Promise.reject(new PodmanError(0, "podman socket not configured"));
    const payload = JSON.stringify({ Detach: false, Tty: false });
    return new Promise((resolve, reject) => {
        let settled = false;
        let out = "";
        let truncated = false;
        // Decode incrementally through ONE StringDecoder rather than
        // body.toString("utf8") per frame: a StringDecoder holds an incomplete
        // multibyte sequence until the bytes completing it arrive, so a UTF-8
        // char split across two libpod frames is reassembled instead of
        // corrupted. stdout and stderr stay merged in arrival order because
        // every frame's payload feeds the same decoder in receipt order.
        const decoder = new StringDecoder("utf8");
        // subarray() returns a Buffer over ArrayBufferLike, so widen the type
        let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        const r = http.request(
            {
                socketPath: socket,
                method: "POST",
                path: `${API}/exec/${id}/start`,
                headers: {
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(payload),
                },
                timeout: opts.timeoutMs,
            },
            (res) => {
                const done = () => {
                    if (settled) return;
                    settled = true;
                    // flush any trailing incomplete sequence (emitted as U+FFFD)
                    // unless we already stopped at the char cap
                    if (!truncated) out += decoder.end();
                    resolve({ output: out, truncated });
                };
                res.on("data", (chunk: Buffer) => {
                    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
                    // de-frame: consume every complete 8-byte-header frame
                    while (buf.length >= 8) {
                        const len = buf.readUInt32BE(4);
                        if (buf.length < 8 + len) break; // wait for the rest
                        const body = buf.subarray(8, 8 + len);
                        buf = buf.subarray(8 + len);
                        if (truncated) continue;
                        const remaining = opts.maxOutput - out.length;
                        if (remaining <= 0) {
                            truncated = true;
                            continue;
                        }
                        // feed raw bytes to the decoder — a partial char at the
                        // frame boundary is buffered inside it, not this frame's
                        // string
                        const text = decoder.write(body);
                        if (!text) continue;
                        if (text.length > remaining) {
                            out += text.slice(0, remaining);
                            truncated = true;
                        } else {
                            out += text;
                        }
                    }
                    if (truncated) {
                        res.destroy();
                        done();
                    }
                });
                res.on("end", done);
                res.on("close", done);
                res.on("error", done); // stream torn down (e.g. our destroy) — keep what we have
            },
        );
        r.on("timeout", () => r.destroy(new PodmanError(0, "sandbox exec timed out")));
        r.on("error", (err) => {
            if (settled) return;
            settled = true;
            reject(
                err instanceof PodmanError
                    ? err
                    : new PodmanError(0, `podman exec socket error: ${err.message}`),
            );
        });
        r.write(payload);
        r.end();
    });
}
