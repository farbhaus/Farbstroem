#!/usr/bin/env bash
#
# deploy.sh — one-click production deployment for Farbström.
#
# From a clean checkout to a running TLS deployment in one command:
#   ./deploy.sh stream.yourdomain.com      (run with bash, not sh)
#
# Designed for a CLEAN VPS where ONLY Farbström runs. It installs missing
# prerequisites (Docker + Compose, openssl) on apt-based hosts,
# generates secrets into .env, opens the firewall, and brings the stack up by
# pulling the published single-container image (which bakes in the frontend, so
# no Node/build toolchain is needed on the host). The containerized Caddy
# provisions Let's Encrypt and owns ALL routing — app, /live/* (OME), and
# LiveKit (proxied same-origin at /livekit/*). One domain, one cert, no host
# web server to configure.
#
# Flags: --regenerate  (start a fresh .env, rotating secrets)
#        --yes          (skip confirmation prompts)
#
# Re-running is safe: an existing .env is reused as-is (secrets are NOT rotated,
# so live sessions survive a redeploy). Use --regenerate to start fresh.
#
# Behind an existing reverse proxy / other services? This one-click script is
# the wrong tool — configure .env by hand instead (see README, "Manual
# configuration").
#
set -euo pipefail
umask 077          # secrets written to .env must not be world-readable

# --- locate repo root -------------------------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ ! -f .env.example ]]; then
  echo "FATAL: .env.example not found next to deploy.sh — run from the repo checkout." >&2
  exit 1
fi

# --- args -------------------------------------------------------------------
REGENERATE=0
ASSUME_YES=0
DOMAIN=""
for arg in "$@"; do
  case "$arg" in
    --regenerate) REGENERATE=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -*) echo "FATAL: unknown option: $arg" >&2; exit 1 ;;
    *) DOMAIN="$arg" ;;
  esac
done

# Privilege prefix for host-level changes (installing packages, firewall).
SUDO=""
[[ ${EUID:-$(id -u)} -ne 0 ]] && SUDO="sudo"

# --- helpers ----------------------------------------------------------------
die()  { echo "FATAL: $*" >&2; exit 1; }
info() { echo "==> $*"; }

# All openssl-based: a `tr </dev/urandom | head` pipeline trips SIGPIPE, which
# under `set -o pipefail` + `set -e` silently aborts the whole script.
gen_secret()   { openssl rand -hex 32; }   # 64 chars, satisfies the >=32 rule in backend/src/config.rs
gen_password() { openssl rand -hex 16; }   # 32 chars, > the 12-char ADMIN_PASSWORD minimum
gen_token()    { openssl rand -hex 4; }    # 8 chars, LIVEKIT_API_KEY suffix

# set_env KEY VALUE — replace the `KEY=...` line in .env in place, preserving
# all comments / blank lines / ordering. Portable (no GNU-vs-BSD `sed -i`).
set_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  local found=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "${key}="* ]]; then
      printf '%s=%s\n' "$key" "$value" >>"$tmp"
      found=1
    else
      printf '%s\n' "$line" >>"$tmp"
    fi
  done <.env
  [[ $found -eq 1 ]] || printf '%s=%s\n' "$key" "$value" >>"$tmp"
  mv "$tmp" .env
}

have_apt() { command -v apt-get >/dev/null 2>&1; }

# install_apt PKG... — install Debian/Ubuntu packages.
install_apt() {
  info "Installing $* (apt)"
  $SUDO apt-get update
  $SUDO apt-get install -y "$@"
}

# install_docker — Docker Engine + Compose v2 plugin via the official script.
install_docker() {
  have_apt || die "Docker not found and auto-install only supports apt-based distros. Install Docker Engine + the Compose v2 plugin: https://docs.docker.com/engine/install/"
  info "Installing Docker Engine + Compose plugin (get.docker.com)"
  curl -fsSL https://get.docker.com | $SUDO sh
  $SUDO systemctl enable --now docker
  # Let the invoking user run docker without sudo on future runs (takes effect
  # after re-login; this run still falls back to sudo via the DOCKER resolver).
  local u="${SUDO_USER:-$USER}"
  [[ -n "$SUDO" && -n "$u" ]] && $SUDO usermod -aG docker "$u" || true
}

# http_ports_busy — true if something is already listening on :80 or :443
# (an existing web server / reverse proxy). This one-click script can't work then.
# Uses ss's port filter (no `-H`, which old iproute2 lacks) and keys on the
# LISTEN state so the header line can't false-match.
http_ports_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -tln 'sport = :80 or sport = :443' 2>/dev/null | grep -q LISTEN
  elif command -v netstat >/dev/null 2>&1; then
    netstat -tln 2>/dev/null \
      | grep -qE '[[:space:]][0-9.:*[]+:(80|443)[[:space:]].*LISTEN'
  else
    return 1   # can't tell — don't block
  fi
}

# stack_running — true if our own compose stack is already up (so :80/:443
# being held by our container is expected, not a foreign-service conflict).
stack_running() {
  $DOCKER compose -f docker-compose.yml ps --status running --services 2>/dev/null \
    | grep -qx farbstroem
}

# ensure_image — make the single-container image available locally under the ref
# the compose file expects. Tries the published image first; if the registry has
# no build for this host's platform (published image is linux/amd64 only, so
# arm64 hosts get "no matching manifest") or the tag is missing, falls back to
# building from the repo root. The Dockerfile builds the backend AND frontend
# internally, so the build needs no host toolchain either way.
ensure_image() {
  if $DOCKER compose -f docker-compose.yml pull 2>/dev/null; then
    return
  fi
  # `|| true` is load-bearing: FARBSTROEM_TAG is usually commented out, so grep
  # finds nothing and exits non-zero — under `set -euo pipefail` that would
  # silently abort the script on this assignment.
  local tag image
  tag="$( { grep -E '^FARBSTROEM_TAG=' .env 2>/dev/null || true; } | cut -d= -f2-)"
  image="zcolor/farbstroem:${tag:-latest}"
  info "No published image for this platform/tag — building from source ($image)"
  $DOCKER build -t "$image" .
}

# Ports the stack needs reachable from the internet. Single source of truth
# for both open_firewall and the printed summary.
FW_TCP=(80 443 1935 3478 7881)
FW_UDP=(443 9999 9998 10000:10009 50000:50100)

# open_firewall — add allow rules to whatever firewall is ALREADY active.
# Deliberately does NOT enable an inactive firewall (that risks an SSH
# lockout and is unnecessary — if nothing's filtering, the ports are open).
open_firewall() {
  if command -v ufw >/dev/null 2>&1 && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
    info "Opening ports via ufw"
    $SUDO ufw allow 22/tcp >/dev/null 2>&1 || true   # never lock out SSH
    local p
    for p in "${FW_TCP[@]}"; do $SUDO ufw allow "${p/:/-}/tcp" >/dev/null 2>&1 || true; done
    for p in "${FW_UDP[@]}"; do $SUDO ufw allow "${p/:/-}/udp" >/dev/null 2>&1 || true; done
    $SUDO ufw reload >/dev/null 2>&1 || true
  elif command -v firewall-cmd >/dev/null 2>&1 && $SUDO firewall-cmd --state >/dev/null 2>&1; then
    info "Opening ports via firewalld"
    local p
    for p in "${FW_TCP[@]}"; do $SUDO firewall-cmd --permanent --add-port="${p/:/-}/tcp" >/dev/null 2>&1 || true; done
    for p in "${FW_UDP[@]}"; do $SUDO firewall-cmd --permanent --add-port="${p/:/-}/udp" >/dev/null 2>&1 || true; done
    $SUDO firewall-cmd --reload >/dev/null 2>&1 || true
  else
    info "No active host firewall (ufw/firewalld) — skipping."
    echo "    If your VPS provider has a CLOUD firewall, open these there:"
    echo "      tcp: ${FW_TCP[*]}"
    echo "      udp: ${FW_UDP[*]}"
  fi
}

# --- verify prerequisites ---------------------------------------------------
info "Checking prerequisites"
command -v curl    >/dev/null 2>&1 || install_apt curl ca-certificates
command -v openssl >/dev/null 2>&1 || install_apt openssl
command -v docker  >/dev/null 2>&1 || install_docker

# Docker present but no Compose v2 plugin (e.g. distro docker.io): add it.
if command -v docker >/dev/null 2>&1 && ! docker compose version >/dev/null 2>&1; then
  have_apt && install_apt docker-compose-plugin
fi

# Resolve how to call docker: a freshly added docker group doesn't apply to
# this shell, so fall back to sudo if the daemon isn't reachable unprivileged.
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  if [[ -n "$SUDO" ]] && $SUDO docker info >/dev/null 2>&1; then
    DOCKER="$SUDO docker"
    info "Using '$DOCKER' (re-login, or 'newgrp docker', to drop sudo for docker)"
  fi
fi

# Re-verify; fail clearly if an install didn't take.
for c in openssl docker; do
  command -v "$c" >/dev/null 2>&1 || die "$c still missing after install attempt — install it manually and re-run."
done
$DOCKER compose version >/dev/null 2>&1 || die "Docker Compose v2 still unavailable — install the Compose plugin and re-run."

# --- domain -----------------------------------------------------------------
if [[ -z "$DOMAIN" ]]; then
  read -rp "Production domain (e.g. stream.example.com): " DOMAIN
fi
[[ -n "$DOMAIN" ]] || die "a production domain is required (needed for TLS)."
# Must be a bare FQDN (no scheme, path, port, spaces; at least one dot) — it
# flows into SITE_ADDRESS, PUBLIC_ORIGIN and the Caddy site address; a bad
# value silently breaks TLS or panics the backend (build_webauthn).
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]]; then
  die "'$DOMAIN' is not a bare hostname. Use e.g. stream.example.com — no https://, no path, no port."
fi

# Fail fast (don't emit a cryptic Docker port-bind error) if something already
# holds 80/443 — UNLESS it's our own already-running stack (a redeploy), which
# must stay idempotent.
if http_ports_busy && ! stack_running; then
  die "ports 80/443 are already in use — this one-click script expects a fresh VPS where only Farbström runs.
       Free 80/443, or if this host already has a reverse proxy, configure .env by
       hand and point the proxy at the stack (see README, 'Manual configuration')."
fi

# --- .env handling ----------------------------------------------------------
ADMIN_PASSWORD=""

# env_complete — true if .env has all required secrets non-empty. Guards
# against reusing a half-written .env left by an aborted earlier run.
env_complete() {
  local k
  for k in JWT_SECRET OME_WEBHOOK_SECRET OME_API_TOKEN LIVEKIT_API_SECRET ADMIN_PASSWORD; do
    grep -qE "^${k}=.+" .env || return 1
  done
  return 0
}

if [[ -f .env ]] && ! env_complete; then
  info ".env exists but is missing required secrets (previous run likely aborted) — regenerating"
  rm -f .env
fi

if [[ -f .env && $REGENERATE -eq 1 ]]; then
  echo "Note: this rotates JWT/secrets (invalidates all sessions). It does NOT"
  echo "reset DB-stored credentials — a custom admin password, TOTP, and passkeys"
  echo "live in ./data/stream.db and keep working (and override the env password)."
  if [[ $ASSUME_YES -eq 1 ]]; then
    info "--regenerate --yes: overwriting .env with fresh secrets"
  else
    read -rp ".env exists — overwrite it and generate fresh secrets? [y/N] " ans
    [[ "${ans,,}" == "y" ]] || die "aborted by user."
  fi
  rm -f .env
fi

if [[ -f .env ]]; then
  info "Reusing existing .env (secrets unchanged)"
  # Backfill secrets introduced in later versions so upgrading an existing
  # deployment picks them up without a manual edit or a full secret rotation.
  # OME_SIGNED_POLICY_SECRET (Farbplay SRT room-link flow) is read by both the
  # backend (env_file) and OME (compose interpolation), so a single value in
  # .env keeps them in sync once both containers are recreated below.
  if ! grep -qE "^OME_SIGNED_POLICY_SECRET=.+" .env; then
    info "Adding OME_SIGNED_POLICY_SECRET to existing .env"
    set_env OME_SIGNED_POLICY_SECRET "$(gen_secret)"
  fi
else
  info "Generating .env for $DOMAIN"
  cp .env.example .env
  ADMIN_PASSWORD="$(gen_password)"
  set_env DOMAIN             "$DOMAIN"
  # Container Caddy provisions Let's Encrypt for the domain itself.
  set_env SITE_ADDRESS       "$DOMAIN"
  # LiveKit is proxied same-origin by the container Caddy at /livekit/*, so the
  # browser sees one wss origin — no separate subdomain, DNS record, or cert.
  set_env LIVEKIT_URL        "wss://$DOMAIN/livekit"
  # WebAuthn relying party: must exactly match the browser's origin or passkey
  # registration/login fails. The .env.example default is a placeholder.
  set_env PUBLIC_ORIGIN      "https://$DOMAIN"
  set_env LIVEKIT_API_KEY    "API$(gen_token)"
  set_env JWT_SECRET         "$(gen_secret)"
  set_env OME_WEBHOOK_SECRET "$(gen_secret)"
  set_env OME_SIGNED_POLICY_SECRET "$(gen_secret)"
  set_env OME_API_TOKEN      "$(gen_secret)"
  set_env LIVEKIT_API_SECRET "$(gen_secret)"
  set_env ADMIN_PASSWORD     "$ADMIN_PASSWORD"
  chmod 600 .env
fi

# --- prepare image + data dir -----------------------------------------------
# The image bakes in www/dist (frontend built inside the Dockerfile), so there's
# no host frontend build and ./www is not bind-mounted in production.
info "Preparing ./data"
mkdir -p data
ensure_image
# No host-side chown: the container fixes /data ownership itself at startup
# (entrypoint.sh chowns it to the unprivileged backend user before the backend
# starts), which works for a root-owned bind mount on a fresh VPS.

# --- firewall ---------------------------------------------------------------
open_firewall

# --- deploy -----------------------------------------------------------------
# -f docker-compose.yml selects ONLY the base file so the dev override
# (docker-compose.override.yml, which builds from source) is NOT merged. The
# single-container image is already local (pulled or built by ensure_image).
info "Starting stack"
$DOCKER compose -f docker-compose.yml up -d

# --- summary ----------------------------------------------------------------
echo
echo "============================================================"
echo " Farbström deployed: https://$DOMAIN"
echo "============================================================"
if [[ -n "$ADMIN_PASSWORD" ]]; then
  echo
  echo "  ADMIN PASSWORD (shown once — save it now):"
  echo "      $ADMIN_PASSWORD"
  if [[ -f data/stream.db ]]; then
    echo
    echo "  NOTE: data/stream.db already exists. If a custom password was set in"
    echo "  the admin UI, it (and any TOTP/passkey) lives in the DB and OVERRIDES"
    echo "  this env password — the password above will NOT work until the DB"
    echo "  override is cleared (break-glass). TOTP/passkeys are unaffected."
  fi
fi
cat <<EOF

  Next steps:
   - Point DNS at this host for:
       $DOMAIN
     (The container Caddy provisions Let's Encrypt on first hit.)
   - Firewall: handled above (or listed there if no host firewall is active —
     open those on your VPS provider's cloud firewall if you have one).
   - Check health:
       $DOCKER compose -f docker-compose.yml ps
       $DOCKER compose -f docker-compose.yml logs -f farbstroem

EOF
