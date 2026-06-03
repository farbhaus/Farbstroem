#!/bin/bash
set -euo pipefail

SITE_ADDRESS="${SITE_ADDRESS:-localhost}"

mkdir -p /etc/caddy /data /var/log/supervisor

# Generate Caddyfile with localhost upstreams (single-container mode)
cat > /etc/caddy/Caddyfile <<EOF
${SITE_ADDRESS} {
	encode gzip zstd

	@prod not host localhost
	header @prod {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Frame-Options "DENY"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		Permissions-Policy "interest-cohort=()"
		Content-Security-Policy "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: https:; font-src 'self' data:; script-src 'self' 'unsafe-inline' https:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss: https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
		-Server
	}

	handle_path /livekit/* {
		reverse_proxy localhost:7880 {
			header_up Host {upstream_hostport}
		}
	}

	handle /live/* {
		reverse_proxy localhost:3333 {
			transport http {
				versions 1.1
			}
			flush_interval -1
		}
	}

	redir /admin /admin/ permanent

	reverse_proxy localhost:4001
}
EOF

# Generate LiveKit config pointing at local Valkey
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

exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
