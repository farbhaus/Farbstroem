#!/usr/bin/env bash
#
# deploy.sh — one-click production deployment for zStream.
#
# From a clean checkout to a running TLS deployment in one command:
#   ./deploy.sh stream.yourdomain.com
#
# Generates secrets into .env, builds the frontend, and brings the stack up.
# The containerized Caddy owns ALL routing (app + /live/ + LiveKit subdomain).
#
# Modes (auto-detected; override with a flag):
#   standalone        — the container Caddy provisions Let's Encrypt itself for
#                        <domain> and lk.<domain>. Default on a dedicated host.
#   behind host Caddy — the host's system Caddy terminates TLS and forwards both
#                        hostnames to :8880. Auto-selected when a populated
#                        /etc/caddy/Caddyfile is found (e.g. the shared project
#                        VPS). The appended host blocks are pure TLS fronts.
#
# Flags: --standalone | --behind-host-caddy | --regenerate | --yes
# Re-running is safe: an existing .env is reused as-is (secrets are NOT rotated,
# so live sessions survive a redeploy). Use --regenerate to start fresh.
#
set -euo pipefail

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
MODE=""           # "", "standalone", or "host" — "" means auto-detect
DOMAIN=""
for arg in "$@"; do
  case "$arg" in
    --regenerate) REGENERATE=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --standalone) MODE="standalone" ;;
    --behind-host-caddy) MODE="host" ;;
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

gen_secret()   { openssl rand -hex 32; }                                        # 64 chars, satisfies the >=32 rule in backend/src/config.rs
gen_password() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20; }       # 20 chars, > the 12-char ADMIN_PASSWORD minimum
gen_token()    { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 12; }

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

# host_caddyfile_populated — true if /etc/caddy/Caddyfile exists and already has
# at least one site block (a non-comment line ending in `{`), i.e. the host
# already serves other domains and should keep terminating TLS.
host_caddyfile_populated() {
  local f="/etc/caddy/Caddyfile"
  [[ -s "$f" ]] || return 1
  grep -vE '^[[:space:]]*(#|$)' "$f" 2>/dev/null \
    | grep -qE '^[[:space:]]*[A-Za-z0-9.:*_-]+[[:space:]]*\{'
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
command -v docker  >/dev/null 2>&1 || die "docker not found — install Docker Engine first."
docker compose version >/dev/null 2>&1 || die "'docker compose' (v2) not available — install the Compose plugin."
command -v openssl >/dev/null 2>&1 || die "openssl not found — required to generate secrets."
command -v node    >/dev/null 2>&1 || die "node not found — required to build the frontend (npm ci && npm run build)."
command -v npm     >/dev/null 2>&1 || die "npm not found — required to build the frontend."

# --- domain -----------------------------------------------------------------
if [[ -z "$DOMAIN" ]]; then
  read -rp "Production domain (e.g. stream.example.com): " DOMAIN
fi
[[ -n "$DOMAIN" ]] || die "a production domain is required (needed for TLS and the lk.<domain> subdomain)."

# --- resolve mode -----------------------------------------------------------
if [[ -z "$MODE" ]]; then
  if host_caddyfile_populated; then
    echo
    echo "Detected a populated /etc/caddy/Caddyfile — this host already serves other"
    echo "domains, so the system Caddy should keep terminating TLS (behind-host-caddy"
    echo "mode). Otherwise this picks standalone (the container Caddy gets its own certs)."
    if [[ $ASSUME_YES -eq 1 ]]; then
      MODE="host"
    else
      read -rp "Use behind-host-caddy mode? [Y/n] " ans
      [[ "${ans,,}" == "n" ]] && MODE="standalone" || MODE="host"
    fi
  else
    MODE="standalone"
  fi
fi
info "Deployment mode: $MODE"

# --- .env handling ----------------------------------------------------------
ADMIN_PASSWORD=""
if [[ -f .env && $REGENERATE -eq 1 ]]; then
  echo "Note: this rotates JWT/secrets (invalidates all sessions). It does NOT"
  echo "reset DB-stored credentials — a custom admin password, TOTP, and passkeys"
  echo "live in ./data/stream.db and keep working (and override the env password)."
  read -rp ".env exists — overwrite it and generate fresh secrets? [y/N] " ans
  [[ "${ans,,}" == "y" ]] || die "aborted by user."
  rm -f .env
fi

if [[ -f .env ]]; then
  info "Reusing existing .env (secrets unchanged)"
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
    # Host Caddy terminates TLS and forwards to :8880; the container Caddy
    # serves plain HTTP. HTTPS_PORT is moved off 443 so the published port
    # mapping can't collide with the host Caddy (which owns 80/443).
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

# --- deploy -----------------------------------------------------------------
info "Starting stack (docker compose up -d --build)"
docker compose up -d --build

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
if [[ "$MODE" == "host" ]]; then
  tls_note="TLS for both is handled by the host Caddy, now configured."
else
  tls_note="The container Caddy provisions Let's Encrypt for both on first hit."
fi
cat <<EOF

  Next steps:
   - Point DNS at this host for BOTH:
       $DOMAIN
       lk.$DOMAIN        (LiveKit signaling — required)
     ($tls_note)
   - Open firewall ports:
       80/tcp  443/tcp  443/udp     (HTTP/HTTPS/HTTP3 — needed for TLS/ACME)
       1935/tcp  9999/udp  9998/udp  3478  7881/tcp
       10000-10009/udp     50000-50100/udp
   - Check health:
       docker compose ps
       docker compose logs -f stream-backend

EOF
