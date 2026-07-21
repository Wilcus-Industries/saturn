# Per-user Podman sandboxes — ops runbook

Saturn runs untrusted agent-authored code inside per-user Linux sandboxes:
rootless **Podman** containers driven by the Node process over the libpod REST
API on a unix socket (`SANDBOX_PODMAN_SOCKET=/run/sandboxes/podman.sock`).

## Architecture

Podman runs as a dedicated **`sandboxes` system user**, never root and never the
app user. WHY: a container escape lands in the `sandboxes` account, which cannot
read `/etc/saturn/saturn.env`, cannot touch `/srv/saturn/app`, and has no login
shell. The saturn app talks to Podman *only* through the libpod socket.

The socket is **relocated** out of the default `/run/user/<uid>/` (mode 0700,
unreachable by the saturn user) to `/run/sandboxes/podman.sock`, a dir that is
mode 0750 owned `sandboxes:sandboxes`. The saturn user is added to the
`sandboxes` group so it can `connect()` the socket, and nothing more.

Egress is locked down with **nftables rules keyed on the sandboxes uid**: all
rootless container traffic NATs out the host as that uid (slirp4netns/pasta), so
one `meta skuid <uid> ... drop` output rule blocks every container's access to
private/link-local ranges (the Pi's LAN, localhost services, cloud-metadata)
with zero per-container plumbing. Public internet egress stays open.

### Security invariants (must all hold)

- **Explicit env only** — containers get exactly the env the app passes; nothing
  inherited from the host.
- **Non-root** — run as uid 1000 (`sandbox` user in the image).
- **Named-volume-only mounts** — the only writable persistent mount is the
  per-box named volume `sb-<uuid>` at `/work`; no host bind mounts.
- **Read-only rootfs + tmpfs `/tmp`** — the image filesystem is immutable at
  runtime.
- **`cap_drop ALL`** — no Linux capabilities.
- **`no_new_privileges`** — no setuid escalation.
- **pids + memory + cpu cgroup limits** — resource ceilings per container.
- **Egress-only network** — no inbound; private ranges dropped by nftables.
- **Host never shell-interprets commands** — the app builds argv arrays and hands
  them to libpod; commands are never concatenated into a host shell string.

## Setup (one time, on the Pi, as root)

`setup-sandboxes.sh` is run **manually once** — it is NOT part of `deploy.sh`.
`deploy.sh` only rsyncs the app + restarts the service, so all host/ops state
(the sandboxes user, socket, nftables, image) is provisioned out of band and
persists across deploys. The `deploy/` files themselves DO ride along on every
deploy automatically — `deploy.sh`'s rsync excludes only `.git`, `node_modules`,
`.next`, `.env*`, and `deploy.sh`, so `Containerfile.sandbox`,
`setup-sandboxes.sh`, and this runbook are always synced to the Pi.

```sh
# on the Pi, from /srv/saturn/app (after a deploy has synced deploy/)
sudo bash deploy/setup-sandboxes.sh
```

It is idempotent (check-then-act) — safe to re-run after a Podman/kernel upgrade.
It creates the `sandboxes` user (+ linger), installs podman/slirp4netns/nftables,
writes the cgroup cpu-delegation drop-in, relocates the socket, installs the
nftables egress rules, and builds `saturn-sandbox:latest`.

Then wire the app:

```sh
# 1. add to /etc/saturn/saturn.env
SANDBOX_PODMAN_SOCKET=/run/sandboxes/podman.sock
# 2. restart (also picks up the new sandboxes group membership)
sudo systemctl restart saturn
```

`saturn.service` already carries `SupplementaryGroups=sandboxes` and
`ReadWritePaths=/run/sandboxes` (connect() needs write on the socket inode, which
`ProtectSystem=strict` blocks otherwise).

## Rebuilding the image

After editing `Containerfile.sandbox`:

```sh
sudo -u sandboxes XDG_RUNTIME_DIR=/run/user/$(id -u sandboxes) \
  podman build -t saturn-sandbox:latest \
  -f /srv/saturn/app/deploy/Containerfile.sandbox /srv/saturn/app/deploy/
```

Build as the `sandboxes` user — rootless Podman only serves images from that
user's own storage over the libpod socket. Existing containers keep their old
image until recreated; new boxes use the rebuilt one.

## Verifying isolation

`_ping` the socket as the app user:

```sh
sudo -u saturn curl --unix-socket /run/sandboxes/podman.sock \
  http://d/v4.0.0/libpod/_ping        # -> OK
```

Then from *inside* a throwaway box (public egress allowed, private ranges blocked):

```sh
sudo -u sandboxes XDG_RUNTIME_DIR=/run/user/$(id -u sandboxes) \
  podman run --rm --network slirp4netns saturn-sandbox:latest \
  bash -c 'curl -sS -m 5 https://example.com >/dev/null && echo NET_OK; \
           curl -sS -m 5 http://10.0.2.2/ ; echo "(LAN/gateway should time out)"'
```

Expect `NET_OK` (public internet works) but the Pi's LAN IP and `10.0.2.2`
(the slirp gateway) to be **dropped/timed out** by the nftables uid rules.

## Orphan garbage collection

Containers/volumes can outlive their registry rows (crash mid-delete, manual
poking). List them (all sandbox objects carry the `saturn.sandbox=1` label /
`sb-` volume prefix) and reconcile against the DB:

```sh
SB="sudo -u sandboxes XDG_RUNTIME_DIR=/run/user/$(id -u sandboxes) podman"
$SB ps -a --filter label=saturn.sandbox=1            # all sandbox containers
$SB volume ls  --filter name=sb-                     # all sandbox volumes
```

Cross-check the `sb-<uuid>` names against the sandbox registry rows in Postgres;
anything with no matching row is an orphan. Remove manually:

```sh
$SB rm -f <container-id>
$SB volume rm sb-<uuid>
```

(Prefer removing the container before its volume; `volume rm` refuses a volume
still attached to a container.)

## Troubleshooting

- **`_ping` fails / connection refused** — socket perms or group membership. Check
  `/run/sandboxes` is `0750 sandboxes:sandboxes`, that `saturn` is in the
  `sandboxes` group (`id saturn`), and that the app was **restarted** after
  `usermod -aG` (a running process keeps its old groups). Confirm the user
  podman.socket is up: `systemctl --user --machine=sandboxes@.host status podman.socket`.
- **Socket won't bind the relocated path** — some podman/systemd builds refuse a
  `ListenStream` outside `XDG_RUNTIME_DIR`. Fallback: leave `podman.socket` on its
  default path and add a **root `systemd-socket-proxyd`** unit forwarding
  `/run/sandboxes/podman.sock` → `/run/user/<sandboxes-uid>/podman/podman.sock`.
- **CPU limits ignored** (containers burn 100% despite a quota) — the cgroup v2
  delegation drop-in is missing or `daemon-reload`/reboot didn't apply it. Verify
  `/etc/systemd/system/user@.service.d/delegate.conf` lists `cpu`, then
  `systemctl daemon-reload` and restart the sandboxes user manager
  (`loginctl terminate-user sandboxes`). Debian delegates only `memory pids` by
  default, so without this the cpu quota silently no-ops.
- **nftables rules gone after reboot** — confirm `/etc/nftables.conf` has the
  `include "/etc/nftables.d/sandboxes.nft"` line and the `nftables` service is
  enabled. Inspect live rules: `sudo nft list table inet saturn_sandboxes`.

### 4GB Pi 4 sizing

This box has 4GB RAM shared with the app (capped at 2G) and the OS. Keep the
global concurrency cap at **2 concurrent sandboxes** and the max-tier per-box
memory limit at **512MB** so two heavy boxes + the app + OS stay under 4GB. Bump
these only after moving to a bigger host.
