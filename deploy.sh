#!/usr/bin/env bash
#
# deploy.sh — one-click production deployment for zStream.
#
# From a clean checkout to a running TLS deployment in one command:
#   ./deploy.sh stream.yourdomain.com      (run with bash, not sh)
#
# Designed for a CLEAN VPS where ONLY zStream runs. It installs missing
# prerequisites (Docker + Compose, Node/npm, openssl; Caddy too for the
# advanced --behind-host-caddy mode) on apt-based hosts,
# generates secrets into .env, opens the firewall, builds the frontend, and
# brings the stack up. The containerized Caddy provisions Let's Encrypt and
# owns ALL routing (app + /live/ + LiveKit subdomain). No host config needed.
#
# If the box already runs other services / a reverse proxy, this is the wrong
# tool for a true one-click — but two advanced opt-in flags exist:
#
# Flags: --regenerate  (start a fresh .env, rotating secrets)
#        --yes          (skip confirmation prompts)
#        --behind-host-caddy   (advanced) host Caddy fronts it; edits /etc/caddy
#        --reverse-proxy       (advanced) stack on :8880; you point nginx/etc at
#                              it — prints the nginx server blocks, touches
#                              nothing. --standalone forces the default.
#
# Re-running is safe: an existing .env is reused as-is (secrets are NOT rotated,
# so live sessions survive a redeploy). Use --regenerate to start fresh.
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
MODE=""           # "" → standalone (default); or "standalone"/"host"/"proxy" via flag
DOMAIN=""
for arg in "$@"; do
  case "$arg" in
    --regenerate) REGENERATE=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --standalone) MODE="standalone" ;;
    --behind-host-caddy) MODE="host" ;;
    --reverse-proxy) MODE="proxy" ;;
    -*) echo "FATAL: unknown option: $arg" >&2; exit 1 ;;
    *) DOMAIN="$arg" ;;
  esac
done

# Privilege prefix for host-level changes (installing Caddy, editing /etc/caddy).
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

# install_host_caddy — install Caddy on the host via the official apt repo.
install_host_caddy() {
  command -v apt-get >/dev/null 2>&1 || die "Caddy is not installed and auto-install only supports apt-based distros. Install it manually: https://caddyserver.com/docs/install"
  info "Installing Caddy (official apt repo)"
  $SUDO apt-get update
  $SUDO apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | $SUDO gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | $SUDO tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  $SUDO apt-get update
  $SUDO apt-get install -y caddy
  $SUDO systemctl enable --now caddy
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

# install_node — Node.js LTS (includes npm) via NodeSource.
install_node() {
  have_apt || die "Node.js not found and auto-install only supports apt-based distros. Install Node.js 20+: https://nodejs.org"
  info "Installing Node.js LTS (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_lts.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
}

# http_ports_busy — true if something is already listening on :80 or :443
# (an existing web server / reverse proxy). Standalone mode can't work then.
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
# being held by our stream-caddy is expected, not a foreign-service conflict).
stack_running() {
  $DOCKER compose ps --status running --services 2>/dev/null \
    | grep -qx stream-caddy
}

# detect_proxy — name of the front proxy already on the box, if recognizable.
detect_proxy() {
  command -v nginx   >/dev/null 2>&1 && { echo nginx;   return; }
  command -v traefik >/dev/null 2>&1 && { echo traefik; return; }
  command -v apache2 >/dev/null 2>&1 && { echo apache;  return; }
  command -v httpd   >/dev/null 2>&1 && { echo apache;  return; }
  echo ""
}

# Ports the stack needs reachable from the internet. Single source of truth
# for both open_firewall and the printed summary. (80/443 only matter in
# standalone mode, where the container Caddy terminates TLS.)
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

# ensure_host_caddy DOMAIN — make sure the host Caddy exists and has pure TLS
# front blocks forwarding DOMAIN and lk.DOMAIN → :8880 (the container Caddy does
# all real routing). Idempotent: only appends if a block for DOMAIN is absent;
# never rewrites existing blocks (the host Caddyfile is shared with other
# domains on this machine).
ensure_host_caddy() {
  local domain="$1" caddyfile="/etc/caddy/Caddyfile"

  command -v caddy >/dev/null 2>&1 || install_host_caddy

  if [[ -f "$caddyfile" ]] && grep -qE "^[[:space:]]*${domain//./\\.}[[:space:]]*\{" "$caddyfile"; then
    info "Host Caddy already has a block for $domain — leaving it untouched"
    return
  fi

  echo
  echo "Host Caddy needs TLS-front site blocks for:"
  echo "    $domain        → localhost:8880"
  echo "    lk.$domain     → localhost:8880"
  echo "These will be APPENDED to $caddyfile (a timestamped backup is taken; existing"
  echo "blocks for other domains are not touched)."
  if [[ $ASSUME_YES -ne 1 ]]; then
    read -rp "Proceed? [y/N] " ans
    [[ "${ans,,}" == "y" ]] || die "aborted — configure $caddyfile manually using caddyfile.example."
  fi

  $SUDO mkdir -p /etc/caddy
  if [[ -f "$caddyfile" ]]; then
    local backup="${caddyfile}.bak.$(date +%Y%m%d%H%M%S)"
    $SUDO cp "$caddyfile" "$backup"
    info "Backed up existing Caddyfile → $backup"
  fi

  # Append the two stream blocks, mirroring caddyfile.example. Both just forward
  # to :8880 — the container Caddy splits app vs LiveKit by Host internally.
  $SUDO tee -a "$caddyfile" >/dev/null <<EOF

# --- zStream ($domain) — added by deploy.sh ---
$domain {
	reverse_proxy localhost:8880
}

lk.$domain {
	reverse_proxy localhost:8880
}
EOF

  if ! $SUDO caddy validate --config "$caddyfile" >/dev/null 2>&1; then
    if [[ -n "${backup:-}" ]]; then
      $SUDO cp "$backup" "$caddyfile"
      die "Caddy config validation failed — restored backup. Check $caddyfile manually."
    fi
    die "Caddy config validation failed — review $caddyfile."
  fi
  $SUDO systemctl reload caddy || $SUDO systemctl restart caddy
  info "Host Caddy configured and reloaded for $domain"
}

# --- verify prerequisites ---------------------------------------------------
info "Checking prerequisites"
command -v curl    >/dev/null 2>&1 || install_apt curl ca-certificates
command -v openssl >/dev/null 2>&1 || install_apt openssl
command -v docker  >/dev/null 2>&1 || install_docker
{ command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; } || install_node

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
for c in openssl docker node npm; do
  command -v "$c" >/dev/null 2>&1 || die "$c still missing after install attempt — install it manually and re-run."
done
$DOCKER compose version >/dev/null 2>&1 || die "Docker Compose v2 still unavailable — install the Compose plugin and re-run."

# --- domain -----------------------------------------------------------------
if [[ -z "$DOMAIN" ]]; then
  read -rp "Production domain (e.g. stream.example.com): " DOMAIN
fi
[[ -n "$DOMAIN" ]] || die "a production domain is required (needed for TLS and the lk.<domain> subdomain)."
# Must be a bare FQDN (no scheme, path, port, spaces; at least one dot) — it
# flows into SITE_ADDRESS, PUBLIC_ORIGIN and the Caddy site address; a bad
# value silently breaks TLS or panics the backend (build_webauthn).
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]]; then
  die "'$DOMAIN' is not a bare hostname. Use e.g. stream.example.com — no https://, no path, no port."
fi

# --- resolve mode -----------------------------------------------------------
# This script targets a CLEAN VPS where only zStream runs: default is
# standalone (the container Caddy gets its own Let's Encrypt certs). Shared
# hosts / existing reverse proxies are advanced, opt-in via explicit flags
# (--behind-host-caddy, --reverse-proxy) — never auto-selected.
[[ -z "$MODE" ]] && MODE="standalone"
info "Deployment mode: $MODE"

# Fail fast (don't emit a cryptic Docker port-bind error) if standalone but
# something already holds 80/443 — UNLESS it's our own already-running stack
# (a redeploy), which must stay idempotent.
if [[ "$MODE" == "standalone" ]] && http_ports_busy && ! stack_running; then
  proxy="$(detect_proxy)"
  die "ports 80/443 are already in use${proxy:+ (looks like $proxy)} — this one-click script expects a fresh VPS where only zStream runs.
       For a host that already has a reverse proxy / other services (advanced):
         --reverse-proxy       stack serves HTTP on :8880; you point your proxy at it
         --behind-host-caddy   if that proxy is Caddy (script manages /etc/caddy)"
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
  # Guard against a silent no-op: the mode-specific values (SITE_ADDRESS etc.)
  # are only written when generating fresh, so a mode flag over an existing
  # .env of a different mode would do nothing. Detect and refuse.
  if grep -qE '^SITE_ADDRESS=:80$' .env; then env_mode="host/proxy"; else env_mode="standalone"; fi
  if { [[ "$MODE" == "standalone" ]] && [[ "$env_mode" != "standalone" ]]; } \
  || { [[ "$MODE" != "standalone" ]] && [[ "$env_mode" != "host/proxy" ]]; }; then
    die "existing .env is configured for $env_mode but you requested $MODE mode.
       Re-run with --regenerate to rewrite .env for the new mode (rotates secrets),
       or remove the flag to keep the current mode."
  fi
  info "Reusing existing .env ($env_mode, secrets unchanged)"
else
  info "Generating .env for $DOMAIN ($MODE mode)"
  cp .env.example .env
  ADMIN_PASSWORD="$(gen_password)"
  set_env DOMAIN             "$DOMAIN"
  if [[ "$MODE" == "standalone" ]]; then
    # Container Caddy provisions Let's Encrypt for both hostnames itself.
    set_env SITE_ADDRESS     "$DOMAIN"
    set_env LK_SITE_ADDRESS  "lk.$DOMAIN"
  else
    # host / proxy: an external front (Caddy or nginx/etc.) terminates TLS and
    # forwards to :8880; the container Caddy serves plain HTTP. HTTPS_PORT is
    # moved off 443 so the published port mapping can't collide with the front.
    set_env SITE_ADDRESS     ":80"
    set_env HTTP_PORT        "8880"
    set_env HTTPS_PORT       "8444"
    set_env LK_SITE_ADDRESS  "http://lk.$DOMAIN"
  fi
  set_env LIVEKIT_URL        "wss://lk.$DOMAIN"
  # WebAuthn relying party: must exactly match the browser's origin or passkey
  # registration/login fails. Admin UI is always reached at https://<domain>
  # (in both modes). The .env.example default is a placeholder — override it.
  set_env PUBLIC_ORIGIN      "https://$DOMAIN"
  set_env LIVEKIT_API_KEY    "API$(gen_token)"
  set_env JWT_SECRET         "$(gen_secret)"
  set_env OME_WEBHOOK_SECRET "$(gen_secret)"
  set_env OME_API_TOKEN      "$(gen_secret)"
  set_env LIVEKIT_API_SECRET "$(gen_secret)"
  set_env ADMIN_PASSWORD     "$ADMIN_PASSWORD"
  chmod 600 .env
fi

# --- host Caddy (only in behind-host-caddy mode) ----------------------------
if [[ "$MODE" == "host" ]]; then
  ensure_host_caddy "$DOMAIN"
fi

# --- build frontend ---------------------------------------------------------
info "Building frontend (npm ci && npm run build)"
( cd frontend && npm ci && npm run build )

# --- prepare bind-mounted data dir ------------------------------------------
# The backend image runs as non-root `app` (Dockerfile: USER app). The
# `./data:/data` bind mount masks the image's `chown app /data`, so a
# fresh root-owned ./data leaves the container unable to create
# /data/stream.db → the backend panics and crash-loops. Chown ./data to the
# image's app uid (mode 0700) rather than world-writable; fall back to 0777
# only if the uid can't be determined.
info "Preparing ./data (owned by the non-root container user)"
mkdir -p data
$DOCKER compose build stream-backend
appuid="$({ $DOCKER compose run --rm --no-deps --entrypoint id stream-backend -u 2>/dev/null || true; } | tr -dc '0-9')"
if [[ -n "$appuid" ]]; then
  $SUDO chown -R "$appuid:$appuid" data
  $SUDO chmod -R u+rwX,go-rwx data
  info "./data owned by container uid $appuid (mode 0700)"
else
  $SUDO chmod -R 777 data
  info "couldn't detect container uid — ./data left world-writable; review perms"
fi

# --- firewall ---------------------------------------------------------------
open_firewall

# --- deploy -----------------------------------------------------------------
info "Starting stack (docker compose up -d --build)"
$DOCKER compose up -d --build

# --- summary ----------------------------------------------------------------
echo
echo "============================================================"
echo " zStream deployed: https://$DOMAIN"
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
case "$MODE" in
  host)  tls_note="TLS for both is handled by the host Caddy, now configured." ;;
  proxy) tls_note="Your existing reverse proxy must terminate TLS for both (see below)." ;;
  *)     tls_note="The container Caddy provisions Let's Encrypt for both on first hit." ;;
esac
cat <<EOF

  Next steps:
   - Point DNS at this host for BOTH:
       $DOMAIN
       lk.$DOMAIN        (LiveKit signaling — required)
     ($tls_note)
   - Firewall: handled above (or listed there if no host firewall is active —
     open those on your VPS provider's cloud firewall if you have one).
   - Check health:
       $DOCKER compose ps
       $DOCKER compose logs -f stream-backend

EOF

if [[ "$MODE" == "proxy" ]]; then
  cat <<EOF
  ── Reverse-proxy setup (REQUIRED — the script did NOT touch your proxy) ──
  The stack now serves plain HTTP on 127.0.0.1:8880. Add these nginx server
  blocks (you provide the TLS certs — e.g. certbot for $DOMAIN and
  lk.$DOMAIN), then \`nginx -t && systemctl reload nginx\`:

    server {
        listen 443 ssl;
        server_name $DOMAIN;
        # ssl_certificate / ssl_certificate_key ... (your certs)
        location / {
            proxy_pass http://127.0.0.1:8880;
            proxy_http_version 1.1;
            proxy_set_header Host              \$host;
            proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto \$scheme;
            proxy_set_header Upgrade           \$http_upgrade;       # WebSocket
            proxy_set_header Connection        "upgrade";
            proxy_read_timeout 86400;
        }
    }

    server {
        listen 443 ssl;
        server_name lk.$DOMAIN;
        # ssl_certificate / ssl_certificate_key ... (your certs)
        location / {
            proxy_pass http://127.0.0.1:8880;
            proxy_http_version 1.1;
            proxy_set_header Host              \$host;
            proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto \$scheme;
            proxy_set_header Upgrade           \$http_upgrade;       # WebSocket
            proxy_set_header Connection        "upgrade";
            proxy_read_timeout 86400;
        }
    }

  Both names go to :8880 — the containerized Caddy splits app vs LiveKit by
  Host internally. Skip the firewall note above for 80/443 (your proxy owns
  them); the other ports still apply.
EOF
fi
