#!/usr/bin/env bash
# One-time (idempotent) host setup for Saturn's per-user Podman sandboxes.
#
# Run this ONCE on the Pi as root (sudo bash deploy/setup-sandboxes.sh); it is
# NOT invoked by deploy.sh — deploy.sh only rsyncs the app and restarts the
# service, so ops changes here are deliberate and out of the deploy hot path.
# Re-running is safe: every step checks-then-acts.
#
# WHY a dedicated `sandboxes` user: rootless Podman runs the containers as that
# unprivileged system user, so a container escape lands in an account that cannot
# read /etc/saturn/saturn.env or touch /srv/saturn/app. The saturn app process
# talks to Podman only over the unix socket at /run/sandboxes/podman.sock.
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "!! must run as root (sudo bash deploy/setup-sandboxes.sh)" >&2
  exit 1
fi

SB_USER=sandboxes
APP_USER=saturn
SOCK_DIR=/run/sandboxes
SOCK_PATH="${SOCK_DIR}/podman.sock"
IMAGE=saturn-sandbox:latest

# Resolve this script's dir so the Containerfile build works from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ">> 1/8 create system user ${SB_USER}"
if ! id -u "${SB_USER}" >/dev/null 2>&1; then
  # -r system account, -m so it gets a home (rootless podman needs ~/.config +
  # ~/.local/share/containers storage), nologin shell (never an interactive login).
  useradd -r -m -s /usr/sbin/nologin "${SB_USER}"
else
  echo "   ${SB_USER} exists"
fi
# Rootless podman user services must survive the user having no active login
# session — linger keeps the user@ manager (and thus podman.socket) running at boot.
loginctl enable-linger "${SB_USER}"

SB_UID="$(id -u "${SB_USER}")"
echo "   ${SB_USER} uid=${SB_UID}"

echo ">> 2/8 install podman + slirp4netns + nftables"
# slirp4netns/pasta gives rootless containers their egress-only userspace network;
# nftables enforces the private-range egress lockdown below.
missing=()
for pkg in podman slirp4netns nftables; do
  dpkg -s "${pkg}" >/dev/null 2>&1 || missing+=("${pkg}")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  apt-get update
  apt-get install -y --no-install-recommends "${missing[@]}"
else
  echo "   podman/slirp4netns/nftables already present"
fi

echo ">> 3/8 cgroups v2 cpu/cpuset/io delegation for user slices"
# WHY: Debian's systemd delegates only `memory pids` to user-manager slices by
# default. Without cpu here, the cpu quota we set on sandbox containers silently
# no-ops (rootless podman can't write cpu.max in an undelegated cgroup). This
# drop-in widens delegation for EVERY user@ manager, which is fine on a single-
# purpose box.
DELEGATE_DIR=/etc/systemd/system/user@.service.d
install -d -m 755 "${DELEGATE_DIR}"
cat > "${DELEGATE_DIR}/delegate.conf" <<'EOF'
[Service]
Delegate=memory pids cpu cpuset io
EOF
systemctl daemon-reload

echo ">> 4/8 relocate the podman socket to ${SOCK_DIR}"
# WHY relocate: the default rootless socket lives under /run/user/<uid>, which is
# mode 0700 owned by ${SB_USER} — the saturn user can't reach it. We publish the
# socket into ${SOCK_DIR} (0750, group ${SB_USER}) and add saturn to that group.
#
# tmpfiles keeps ${SOCK_DIR} recreated on every boot (it lives on tmpfs /run).
cat > /etc/tmpfiles.d/sandboxes.conf <<EOF
d ${SOCK_DIR} 0750 ${SB_USER} ${SB_USER} -
EOF
systemd-tmpfiles --create /etc/tmpfiles.d/sandboxes.conf

# Give the app user read/connect access to the socket dir via the group.
usermod -aG "${SB_USER}" "${APP_USER}"

# podman.socket drop-in: reset the default XDG listener (blank ListenStream=)
# then bind our relocated path instead.
SB_HOME="$(getent passwd "${SB_USER}" | cut -d: -f6)"
DROPIN_DIR="${SB_HOME}/.config/systemd/user/podman.socket.d"
install -d -m 755 "${DROPIN_DIR}"
cat > "${DROPIN_DIR}/override.conf" <<EOF
[Socket]
ListenStream=
ListenStream=${SOCK_PATH}
EOF
# The whole ~/.config tree must be owned by ${SB_USER} or the user manager ignores it.
chown -R "${SB_USER}:${SB_USER}" "${SB_HOME}/.config"

# Talk to the sandboxes user's systemd manager. --machine=${SB_USER}@.host runs
# `systemctl --user` against that user's manager without a login session (linger
# from step 1 keeps it alive).
run_user_ctl() {
  systemctl --user --machine="${SB_USER}@.host" "$@"
}
run_user_ctl daemon-reload
if ! run_user_ctl enable --now podman.socket; then
  cat >&2 <<EOF
!! podman.socket failed to bind ${SOCK_PATH}.
   FALLBACK: some podman/systemd builds refuse a ListenStream outside
   XDG_RUNTIME_DIR. If so, leave podman.socket on its default path and add a
   ROOT systemd-socket-proxyd unit that forwards ${SOCK_PATH} ->
   /run/user/${SB_UID}/podman/podman.sock (proxy runs as ${SB_USER}). See
   deploy/sandboxes.md "Troubleshooting".
EOF
fi

echo ">> 5/8 nftables egress lockdown for uid ${SB_UID}"
# WHY keyed on the uid: all rootless container traffic egresses the HOST as the
# ${SB_USER} uid (slirp4netns/pasta NATs it), so a single skuid-matched output
# rule covers every sandbox with no per-container plumbing. We drop only NEW
# egress from that uid to private/link-local ranges — this blocks the containers
# from reaching the Pi's LAN, other services on localhost, and cloud-metadata —
# while everything else default-accepts (egress-only internet stays open).
NFT_FILE=/etc/nftables.d/sandboxes.nft
install -d -m 755 /etc/nftables.d
cat > "${NFT_FILE}" <<EOF
# Managed by deploy/setup-sandboxes.sh — do not edit by hand.
# Drop sandbox (${SB_USER}, uid ${SB_UID}) egress to private address space.
table inet saturn_sandboxes {
  chain output {
    type filter hook output priority filter; policy accept;
    meta skuid ${SB_UID} ip daddr { 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 } drop
    meta skuid ${SB_UID} ip6 daddr { ::1/128, fe80::/10, fc00::/7 } drop
  }
}
EOF

# Debian's /etc/nftables.conf is the boot ruleset; make it include our file so
# the rules reload on boot. (Debian convention: /etc/nftables.conf includes
# extra files; there is no auto-included /etc/nftables.d, so we add the line.)
NFT_CONF=/etc/nftables.conf
INCLUDE_LINE="include \"${NFT_FILE}\""
if [[ -f "${NFT_CONF}" ]] && ! grep -qF "${INCLUDE_LINE}" "${NFT_CONF}"; then
  printf '\n# Saturn sandbox egress rules\n%s\n' "${INCLUDE_LINE}" >> "${NFT_CONF}"
fi
systemctl enable nftables >/dev/null 2>&1 || true
# Reload the full ruleset (idempotent — the table is replaced, not appended).
if ! nft -f "${NFT_CONF}"; then
  echo "!! nft reload of ${NFT_CONF} failed — check syntax; applying our file alone" >&2
  nft -f "${NFT_FILE}"
fi

echo ">> 6/8 build the sandbox image as ${SB_USER}"
# Build in the sandboxes user's own rootless storage — that is the only storage
# the libpod socket serves, so the app can `podman create` from it.
sudo -u "${SB_USER}" XDG_RUNTIME_DIR="/run/user/${SB_UID}" \
  podman build -t "${IMAGE}" -f "${SCRIPT_DIR}/Containerfile.sandbox" "${SCRIPT_DIR}"

echo ">> 7/8 disk space check"
# Container images + named volumes live under the sandboxes user's home. Warn
# early if the storage volume is tight (image alone is ~500MB, volumes grow).
STORAGE_PATH="${SB_HOME}"
AVAIL_KB="$(df -Pk "${STORAGE_PATH}" | awk 'NR==2 {print $4}')"
AVAIL_GB=$(( AVAIL_KB / 1024 / 1024 ))
if [[ ${AVAIL_GB} -lt 10 ]]; then
  echo "!! only ${AVAIL_GB}GB free on $(df -Ph "${STORAGE_PATH}" | awk 'NR==2 {print $6}') — sandboxes want >=10GB" >&2
else
  echo "   ${AVAIL_GB}GB free — ok"
fi

echo ">> 8/8 done"
cat <<EOF

Smoke test the socket AS THE APP USER (must print an OK ping):
  sudo -u ${APP_USER} curl --unix-socket ${SOCK_PATH} http://d/v4.0.0/libpod/_ping

Then wire the app up:
  1. add this line to /etc/saturn/saturn.env:
       SANDBOX_PODMAN_SOCKET=${SOCK_PATH}
  2. restart the app:  sudo systemctl restart saturn
     (saturn.service already grants SupplementaryGroups=${SB_USER} +
      ReadWritePaths=${SOCK_DIR}, so it can connect once the env var is set.)

NOTE: the saturn user was just added to the ${SB_USER} group — the running
saturn process only picks up the new group on restart (step 2 covers it).
EOF
