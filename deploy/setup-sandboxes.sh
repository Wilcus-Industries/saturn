#!/usr/bin/env bash
# One-time (idempotent) host setup for Saturn's per-user Podman sandboxes.
#
# Run this ONCE on a new box as root (sudo bash deploy/setup-sandboxes.sh); it is
# NOT invoked by deploy.sh — deploy.sh only rsyncs the app and restarts the
# service, so ops changes here are deliberate and out of the deploy hot path.
# Re-running is safe: every step checks-then-acts (fully idempotent).
#
# The last two steps make provisioning turnkey: step 8 self-verifies the runtime
# (socket reachable, image resolves, egress locked down) and ABORTS on any
# failure — a broken host never gets the feature enabled; step 9 then wires
# SANDBOX_PODMAN_SOCKET into /etc/saturn/saturn.env and restarts saturn. So on a
# machine where the app is already deployed, this one command takes sandboxes
# from nothing to live-and-verified.
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

echo ">> 1/9 create system user ${SB_USER}"
# Ensure the group exists first and pin the user to it with -g. WHY: on Debian
# (USERGROUPS_ENAB yes) a bare `useradd` tries to create a per-user group and
# ERRORS if one named ${SB_USER} already exists (e.g. a deploy created it for
# saturn.service's SupplementaryGroups). Creating it ourselves + -g makes this
# step idempotent regardless of prior state.
getent group "${SB_USER}" >/dev/null 2>&1 || groupadd -r "${SB_USER}"
if ! id -u "${SB_USER}" >/dev/null 2>&1; then
  # -r system account, -m so it gets a home (rootless podman needs ~/.config +
  # ~/.local/share/containers storage), nologin shell (never an interactive login).
  useradd -r -m -s /usr/sbin/nologin -g "${SB_USER}" "${SB_USER}"
else
  echo "   ${SB_USER} exists"
fi
# Rootless podman user services must survive the user having no active login
# session — linger keeps the user@ manager (and thus podman.socket) running at boot.
loginctl enable-linger "${SB_USER}"

SB_UID="$(id -u "${SB_USER}")"
echo "   ${SB_USER} uid=${SB_UID}"

# Rootless podman maps container uids/gids through a subordinate range in
# /etc/subuid + /etc/subgid. `useradd -r` (system account) does NOT allocate one,
# so without this podman fails: "no subuid ranges found for user sandboxes". Give
# it a 65536 block starting after the highest range already present (avoids
# colliding with e.g. lucas:100000:65536). Idempotent: only added once.
if ! grep -q "^${SB_USER}:" /etc/subuid; then
  SUB_START="$(awk -F: 'BEGIN{m=100000}{e=$2+$3; if(e>m)m=e} END{print m}' \
    /etc/subuid /etc/subgid 2>/dev/null)"
  : "${SUB_START:=165536}"
  usermod --add-subuids "${SUB_START}-$((SUB_START+65535))" \
          --add-subgids "${SUB_START}-$((SUB_START+65535))" "${SB_USER}"
  echo "   allocated subid range ${SUB_START}-$((SUB_START+65535))"
  # podman caches the mapping; make it re-read the fresh ranges.
  sudo -u "${SB_USER}" XDG_RUNTIME_DIR="/run/user/${SB_UID}" \
    podman system migrate >/dev/null 2>&1 || true
else
  echo "   subid range already allocated"
fi

echo ">> 2/9 install podman + pasta/slirp4netns + nftables + uidmap"
# Rootless container networking: podman 5.x defaults to pasta (from the `passt`
# package); slirp4netns is kept as the fallback engine. Both give egress-only
# userspace NAT with no host-loopback, and both egress the HOST as the sandboxes
# uid — so the nftables skuid rule below locks either one down identically.
# uidmap provides newuidmap/newgidmap — REQUIRED for rootless multi-id namespace
# mapping (podman fails "command required for rootless mode with multiple IDs"
# without it). All three (passt, slirp4netns, uidmap) are only Recommends of
# podman, so --no-install-recommends drops them and we must name them explicitly.
missing=()
for pkg in podman passt slirp4netns nftables uidmap; do
  dpkg -s "${pkg}" >/dev/null 2>&1 || missing+=("${pkg}")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  apt-get update
  apt-get install -y --no-install-recommends "${missing[@]}"
else
  echo "   podman/slirp4netns/nftables already present"
fi

echo ">> 3/9 cgroups v2 cpu/cpuset/io delegation for user slices"
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

echo ">> 4/9 relocate the podman socket to ${SOCK_DIR}"
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

echo ">> 4b/9 grant saturn.service access to the socket (drop-in)"
# WHY a drop-in and not the base saturn.service: these two grants reference host
# state (${SB_USER} group, ${SOCK_DIR}) that only exists AFTER this script runs.
# Baking them into the shipped unit would wedge every deploy on an un-provisioned
# box (216/GROUP then 226/NAMESPACE). Installing them here means the grants appear
# exactly when the host is ready. ReadWritePaths is additive across drop-ins, so
# the base unit's .next/cache grant is preserved.
SATURN_DROPIN_DIR=/etc/systemd/system/saturn.service.d
install -d -m 755 "${SATURN_DROPIN_DIR}"
cat > "${SATURN_DROPIN_DIR}/sandbox.conf" <<EOF
# Managed by deploy/setup-sandboxes.sh — grants the saturn app access to the
# rootless Podman socket. Remove this file to fully detach the sandbox feature.
[Service]
SupplementaryGroups=${SB_USER}
ReadWritePaths=${SOCK_DIR}
EOF
systemctl daemon-reload

echo ">> 5/9 nftables egress lockdown for uid ${SB_UID}"
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

echo ">> 6/9 build the sandbox image as ${SB_USER}"
# Build in the sandboxes user's own rootless storage — that is the only storage
# the libpod socket serves, so the app can `podman create` from it.
#
# Build from a ${SB_USER}-owned temp dir, NOT ${SCRIPT_DIR}: the script's cwd is
# root's login dir (e.g. /home/lucas, mode 700) which ${SB_USER} cannot chdir
# into ("cannot chdir to /home/lucas: Permission denied"), and ${SCRIPT_DIR}
# under /srv/saturn/app may be unreadable to it too. Copy the small context out.
BUILD_DIR="$(mktemp -d /tmp/saturn-sandbox-build.XXXXXX)"
cp "${SCRIPT_DIR}/Containerfile.sandbox" "${BUILD_DIR}/Containerfile.sandbox"
chown -R "${SB_USER}:${SB_USER}" "${BUILD_DIR}"
sudo -u "${SB_USER}" XDG_RUNTIME_DIR="/run/user/${SB_UID}" \
  sh -c "cd '${BUILD_DIR}' && exec podman build -t '${IMAGE}' -f Containerfile.sandbox ."
rm -rf "${BUILD_DIR}"

echo ">> 7/9 disk space check"
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

echo ">> 8/9 self-verify runtime (fails loud so a broken host never ships)"
# Prove the three things that actually broke during first provisioning, so a NEW
# machine surfaces any drift HERE, not silently at the first agent run:
#   a) the app user can reach the libpod socket (group/perms),
#   b) the image resolves under the exact name the app requests, and
#   c) container egress is contained (public reachable, private space dropped).
verify_fail=0

# a) socket reachable by the app user over the relocated unix socket.
if [[ "$(sudo -u "${APP_USER}" curl -s --unix-socket "${SOCK_PATH}" \
        http://d/v4.0.0/libpod/_ping 2>/dev/null)" == "OK" ]]; then
  echo "   [ok] socket ping as ${APP_USER}"
else
  echo "!! [FAIL] ${APP_USER} cannot ping ${SOCK_PATH} — check group membership + dir perms" >&2
  verify_fail=1
fi

# b) image present via the API under the unqualified name lib/sandbox.server.ts uses.
IMG_CODE="$(sudo -u "${APP_USER}" curl -s -o /dev/null -w '%{http_code}' \
  --unix-socket "${SOCK_PATH}" "http://d/v4.0.0/libpod/images/${IMAGE}/exists" 2>/dev/null || true)"
if [[ "${IMG_CODE}" == 204 ]]; then
  echo "   [ok] image ${IMAGE} resolves"
else
  echo "!! [FAIL] image ${IMAGE} not found via API (HTTP ${IMG_CODE:-none}) — build step failed?" >&2
  verify_fail=1
fi

# c) network containment: run a throwaway container as ${SB_USER} and assert public
# egress works while the Pi's own LAN is DROPPED by the nftables skuid rule. Uses
# sshd (:22, a reliable local listener) as the private-reachability probe: a TCP
# connect that succeeds means the lockdown is broken. Runs from /tmp — ${SB_USER}
# cannot chdir into root's login dir. rc legend: 20 no internet / 21 bad status /
# 22 REACHED the Pi LAN (nft broken).
LANIP="$(hostname -I | awk '{print $1}')"
egress_rc=0
( cd /tmp && sudo -u "${SB_USER}" XDG_RUNTIME_DIR="/run/user/${SB_UID}" \
    podman run --rm "${IMAGE}" bash -lc "
      code=\$(curl -sS -m 8 -o /dev/null -w '%{http_code}' https://example.com) || exit 20
      [ \"\$code\" = 200 ] || exit 21
      timeout 5 bash -c 'exec 3<>/dev/tcp/${LANIP}/22' 2>/dev/null && exit 22
      exit 0
    " ) || egress_rc=$?
if [[ ${egress_rc} -eq 0 ]]; then
  echo "   [ok] egress: public https reachable, Pi LAN ${LANIP} blocked"
else
  echo "!! [FAIL] egress self-test rc=${egress_rc} (20=no internet 21=bad status 22=REACHED Pi LAN — nft lockdown broken)" >&2
  verify_fail=1
fi

if [[ ${verify_fail} -ne 0 ]]; then
  echo "!! runtime verification FAILED — leaving the feature OFF. Fix the above, re-run." >&2
  echo "   (SANDBOX_PODMAN_SOCKET is NOT wired, so the app stays safely degraded.)" >&2
  exit 1
fi
echo "   all runtime checks passed"

echo ">> 9/9 wire the app + restart"
# Turn the feature on: set SANDBOX_PODMAN_SOCKET and bounce the service. Only done
# once verification passed, so we never point a live app at a broken runtime.
ENV_FILE=/etc/saturn/saturn.env
if [[ -f "${ENV_FILE}" ]]; then
  if grep -q '^SANDBOX_PODMAN_SOCKET=' "${ENV_FILE}"; then
    echo "   ${ENV_FILE} already sets SANDBOX_PODMAN_SOCKET"
  else
    printf 'SANDBOX_PODMAN_SOCKET=%s\n' "${SOCK_PATH}" >> "${ENV_FILE}"
    echo "   added SANDBOX_PODMAN_SOCKET=${SOCK_PATH}"
  fi
  if systemctl cat saturn.service >/dev/null 2>&1; then
    systemctl restart saturn
    sleep 3
    if systemctl is-active --quiet saturn; then
      echo "   saturn restarted — sandboxes are LIVE"
    else
      echo "!! saturn did not come back — inspect: journalctl -u saturn -n 30" >&2
      exit 1
    fi
  else
    echo "   (no saturn.service installed yet — run deploy.sh, then: sudo systemctl restart saturn)"
  fi
else
  cat <<EOF2
   ${ENV_FILE} not found — app not deployed on this box yet. After deploy.sh:
     echo 'SANDBOX_PODMAN_SOCKET=${SOCK_PATH}' | sudo tee -a ${ENV_FILE}
     sudo systemctl restart saturn
EOF2
fi

echo ">> done. Sandbox runtime provisioned + verified."
