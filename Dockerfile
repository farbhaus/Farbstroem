# Single-container build for Farbstroem
# Combines OvenMediaEngine, Valkey, LiveKit, Caddy, and the Rust backend.

# ------------------------------------------------------------------------------
# Stage 1 — Backend builder (Debian-based, matches final glibc)
# ------------------------------------------------------------------------------
FROM rust:1-bookworm AS backend-builder
RUN apt-get update && apt-get install -y libssl-dev pkg-config && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/Cargo.toml backend/Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release 2>/dev/null; rm -rf src
COPY backend/src/ ./src/
COPY backend/schema.sql ./
RUN touch src/main.rs && cargo build --release

# ------------------------------------------------------------------------------
# Stage 2 — Valkey builder
# ------------------------------------------------------------------------------
FROM ubuntu:22.04 AS valkey-builder
RUN apt-get update && apt-get install -y build-essential curl && rm -rf /var/lib/apt/lists/*
ARG VALKEY_VERSION=8.0.0
RUN curl -L "https://github.com/valkey-io/valkey/archive/refs/tags/${VALKEY_VERSION}.tar.gz" | tar xz -C /tmp \
    && cd /tmp/valkey-* && make && make install

# ------------------------------------------------------------------------------
# Stage 3 — LiveKit downloader
# ------------------------------------------------------------------------------
FROM ubuntu:22.04 AS livekit-downloader
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
RUN curl -L -o /livekit-server \
       "https://github.com/livekit/livekit/releases/latest/download/livekit-server-linux-${TARGETARCH}" \
    && chmod +x /livekit-server

# ------------------------------------------------------------------------------
# Stage 4 — Caddy downloader
# ------------------------------------------------------------------------------
FROM ubuntu:22.04 AS caddy-downloader
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
RUN curl -L -o /caddy \
       "https://github.com/caddyserver/caddy/releases/latest/download/caddy_linux_${TARGETARCH}" \
    && chmod +x /caddy

# ------------------------------------------------------------------------------
# Stage 5 — Final image (OME Ubuntu base)
# ------------------------------------------------------------------------------
FROM airensoft/ovenmediaengine:latest

# Runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    supervisor \
    ca-certificates \
    libssl3 \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Valkey
COPY --from=valkey-builder /usr/local/bin/valkey-server /usr/local/bin/valkey-server

# LiveKit
COPY --from=livekit-downloader /livekit-server /usr/local/bin/livekit-server

# Caddy
COPY --from=caddy-downloader /caddy /usr/local/bin/caddy

# Backend binary + schema
COPY --from=backend-builder /app/target/release/stream-backend /usr/local/bin/stream-backend
COPY --from=backend-builder /app/schema.sql /app/schema.sql

# Static web assets
COPY www/ /www/

# OME configuration overrides
COPY ome/origin_conf/ /opt/ovenmediaengine/bin/origin_conf/

# Supervisor + entrypoint
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Single-container env defaults
ENV PORT=4001
ENV DB_PATH=/data/stream.db
ENV DATA_PATH=/data
ENV OME_API_URL=http://localhost:8081/v1
ENV LIVEKIT_INTERNAL_URL=http://localhost:7880
ENV LIVEKIT_URL=ws://localhost:7880
ENV PUBLIC_ORIGIN=http://localhost

# Caddy / LiveKit / OME / Backend / Valkey
EXPOSE 80 443 443/udp
EXPOSE 4001
EXPOSE 1935
EXPOSE 9999/udp 9998/udp
EXPOSE 3478
EXPOSE 10000-10009/udp
EXPOSE 7880 7881
EXPOSE 50000-50100/udp

HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=30s \
    CMD wget -q -O- http://127.0.0.1:4001/healthz || exit 1

ENTRYPOINT ["/entrypoint.sh"]
