#!/bin/bash
set -euo pipefail

# Exported so the COPY'd /etc/caddy/Caddyfile ({$SITE_ADDRESS:localhost}) and the
# derived URLs below all resolve from one knob.
export SITE_ADDRESS="${SITE_ADDRESS:-localhost}"

mkdir -p /data /var/log/supervisor

# The backend runs unprivileged (supervisord `user=app`) and owns the SQLite DB
# + uploads under /data. /data is a bind mount/volume, so fix ownership here at
# runtime — a build-time chown wouldn't survive the mount.
chown -R app:app /data

# Generate LiveKit config pointing at local Valkey. Keys are inlined into the
# YAML here (entrypoint still has the full env), so the livekit process itself
# needs no key secrets in its environment — supervisord blanks them for it.
LIVEKIT_API_KEY="${LIVEKIT_API_KEY:-devkey}"
LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET:-secret}"
cat > /livekit.yaml <<EOF
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50100
  use_external_ip: true
redis:
  address: localhost:6379
keys:
  ${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}
logging:
  level: info
EOF

export OME_HOST_IP="${DOMAIN:-localhost}"

# Caddy always fronts this container over HTTPS (auto internal-CA cert on
# localhost, auto Let's Encrypt on a real domain) and proxies LiveKit at
# /livekit, so every browser-facing URL is fully determined by SITE_ADDRESS.
# Derive them here — SITE_ADDRESS is the single knob to point this container at
# a domain, and this overrides any stale per-flow value from .env (e.g. the
# bare `cargo run` dev default of http://localhost:4001).
export PUBLIC_ORIGIN="https://${SITE_ADDRESS}"
export LIVEKIT_URL="wss://${SITE_ADDRESS}/livekit"

exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
