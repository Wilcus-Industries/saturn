# Deploying Saturn

Saturn is self-hosted on one Linux box (the Pi `saturn.local`) as a single
hardened Node process behind a Cloudflare Tunnel. This is the whole runbook —
from a bare machine to a live, sandbox-capable deploy.

If the box is **already set up** and you just want to ship code, skip to
[Redeploy](#redeploy). Everything below is ordered; run it top to bottom.

---

## 0. One-time host bootstrap (manual)

These prepare a *fresh* machine and are done once, as an admin with sudo. On the
existing Pi they are already in place — don't re-run them.

1. **App user + paths**
   ```sh
   sudo useradd -r -m -d /srv/saturn saturn        # service account
   sudo install -d -o "$USER" -g "$USER" /srv/saturn/app   # you rsync here
   sudo install -d -o saturn -g saturn /etc/saturn
   ```
2. **Node** (match the version the app builds with — Node 22 LTS):
   ```sh
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs
   ```
3. **Secrets** — create `/etc/saturn/saturn.env` (mode 0640, owned `saturn`) from
   `.env.example`. Fill every required var (Google OAuth, Stripe keys+price ids,
   `DATABASE_URL`, `BETTER_AUTH_URL=https://saturn.wilcus.com`,
   `PLATFORM_OPENROUTER_KEY`, …). Leave `SANDBOX_PODMAN_SOCKET` **unset** — step 3
   wires it. Do NOT commit this file; `deploy.sh` never rsyncs `.env*`.
4. **better-auth tables** (once, and after any better-auth plugin change):
   ```sh
   npx @better-auth/cli@latest migrate --config lib/auth.ts   # oauthApplication/…/oauthConsent
   ```
5. **Cloudflare Tunnel** → `127.0.0.1:3000`, and DNS for `saturn.wilcus.com`.
   (Out of scope here — configure `cloudflared` per its own runbook.)

> The app-owned schema (`db/setup.sql`) is **not** a manual step — `deploy.sh`
> applies it every deploy (idempotent). See step 1.

---

## 1. Deploy the app

From the **dev checkout** (needs `ssh` to the box + `psql` locally with
`DATABASE_URL` reachable — Neon is reachable from anywhere):

```sh
./deploy.sh
```

What it does, in order:
1. **Applies `db/setup.sql`** to the app database (idempotent; skip with
   `SKIP_DB_MIGRATE=1`; `DATABASE_URL` from your env or `.env.local`).
2. rsyncs the source to `saturn.local:/srv/saturn/app` (excludes `.git`,
   `node_modules`, `.next`, `.env*`).
3. On the box: `npm ci` → `next build` (with `/etc/saturn/saturn.env` loaded),
   installs `deploy/saturn.service`, `daemon-reload`, restarts `saturn`, and
   asserts the service is `active`.

The base `saturn.service` carries **no** sandbox-specific grants, so this boots
cleanly whether or not the box has been sandbox-provisioned.

At this point the app is live. Sandboxes are **dormant** (their tools return
"sandbox runtime not configured") until step 3.

---

## 2. (Optional) Provision the sandbox runtime

Only if you want agent sandboxes on this box. One command, run **on the box** as
root. It is idempotent, **self-verifying**, and **self-wiring**:

```sh
sudo bash /srv/saturn/app/deploy/setup-sandboxes.sh
```

It creates the `sandboxes` user (+ subuid range), installs podman/pasta/uidmap,
delegates cgroup cpu, relocates the libpod socket to `/run/sandboxes/podman.sock`,
installs the `saturn.service.d/sandbox.conf` grant drop-in, applies the nftables
egress lockdown, and builds `saturn-sandbox:latest`. Then:

- **Step 8 verifies** the runtime — socket reachable by the app user, image
  resolves, and container egress is contained (public reachable, Pi LAN dropped).
  Any failure **aborts** and leaves the feature off, so a broken host never ships.
- **Step 9 wires it on** — adds `SANDBOX_PODMAN_SOCKET` to `/etc/saturn/saturn.env`
  and restarts `saturn`. Sandboxes are now live.

Deep-dive, security invariants, and troubleshooting: **[`sandboxes.md`](./sandboxes.md)**.

---

## Redeploy

Just ship code again:

```sh
./deploy.sh
```

Sandbox provisioning (step 2) is **not** repeated on redeploy and doesn't need to
be — the grants live in a drop-in and the socket/image persist. Re-run
`setup-sandboxes.sh` only to rebuild the image (`podman ... build`, see
`sandboxes.md`) or after wiping the host.

---

## Files in this dir

| File | Role |
|---|---|
| `saturn.service` | systemd unit (base — no sandbox grants) |
| `setup-sandboxes.sh` | one-time sandbox host provisioning (idempotent, self-verifying) |
| `Containerfile.sandbox` | the `saturn-sandbox:latest` image |
| `sandboxes.md` | sandbox architecture + ops runbook |
