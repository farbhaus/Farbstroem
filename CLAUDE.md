# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

zStream is a private low-latency streaming platform for color-grading review sessions. It combines OvenMediaEngine (OME) for broadcast ingest/delivery, LiveKit for participant voice/video, and a Rust/Axum backend for API and session management. The frontend is vanilla JS with no build step.

## Commands

### Backend (Rust — `backend/`)

```bash
cargo check                              # fast type check
cargo build --release                    # production binary
cargo test                               # run all ~70 integration tests
cargo test --test rooms_public_test      # single test file
cargo test --test rooms_public_test join_creates_participant  # single test
RUST_LOG=debug cargo test -- --nocapture # tests with logs
cargo fmt                                # format
cargo clippy --all-targets -- -D warnings
cargo audit
```

Hot-reload during development (requires `watchexec-cli`):
```bash
watchexec -r -e rs -- cargo run
```

### Full stack (Docker Compose — repo root)

```bash
docker compose up -d                     # start all 5 services
docker compose up -d --build stream-backend  # rebuild after Rust changes
docker compose down
```

### Environment setup

```bash
cp .env.example .env
# Fill in secrets — generate with: openssl rand -hex 32
```

Required variables: `JWT_SECRET`, `OME_WEBHOOK_SECRET`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `ADMIN_PASSWORD` (12+ chars, bcrypt-hashed at startup).

## Architecture

```
Encoder (SRT/RTMP/WHIP)
  └─→ stream-ome (OvenMediaEngine)
        ├─ admission webhook → stream-backend (HMAC-SHA1 verified)
        └─→ Browser (OvenPlayer via LLHLS/WebRTC, routed through Caddy /live/*)

stream-backend (Rust/Axum, :4001)
  ├─ HTTP API   /api/*        — rooms, participants, chat, stream keys, admin auth
  ├─ WebSocket  /ws/room/:slug — presence, chat, pointer overlay, kick events
  ├─ Static     /admin/, /watch/:slug, /  — serves www/ files
  └─ SQLite WAL  /data/stream.db

Browser (viewer page)
  ├─ OvenPlayer — stream video
  ├─ LiveKit JS SDK — camera/mic/screen share ↔ stream-livekit
  └─ WebSocket — chat, presence, pointer ↔ stream-backend
```

**Services in docker-compose:** `stream-caddy` (TLS + routing), `stream-backend`, `stream-ome`, `stream-livekit` (SFU, backed by `stream-redis`).

## Backend structure

- `src/main.rs` — startup: config, DB pool, background tasks, Axum router mount on :4001
- `src/lib.rs` — re-exports the app builder so integration tests can spin up the server in-process
- `src/config.rs` — `AppConfig::from_env`, secret length validation (fail-fast)
- `src/state.rs` — `AppState` (Arc'd, cloned into handlers)
- `src/db.rs` — R2D2 SQLite pool (10 connections), WAL mode, schema bootstrap from `schema.sql`
- `src/error.rs` — `AppError` + `IntoResponse` impl; central error → HTTP mapping
- `src/events.rs` — typed WS event payloads shared between hub and routes
- `src/auth.rs` — JWT (HS256, 7d) + bcrypt helpers
- `src/livekit.rs` — hand-rolled LiveKit client: AccessToken JWT minting + RoomService HTTP
- `src/ws.rs` — WebSocket hub, broadcast channels per room
- `src/tasks.rs` — background pollers: OME stream status, room expiry, file cleanup
- `src/routes/` — one file per resource: `rooms`, `rooms_public`, `files`, `admin_files`, `stream_keys`, `webhook`, `branding`, `metrics`, `ome`, `auth`, `rate_limit`
- `tests/common/mod.rs` — shared test fixtures (in-memory DB, app setup)

## Frontend structure

`www/` is served as static files directly by the backend — no build step, no bundler.

- `www/shared/` — design system: `tokens.css`, `components.css`, `utils.css`, `utils.js` (API wrapper, toast/modal helpers)
- `www/viewer/index.html` — participant page: join form → OvenPlayer + LiveKit tiles + chat + pointer overlay
- `www/admin/index.html` — admin SPA: room CRUD, stream keys, file library, branding
- `www/landing/index.html` — public homepage

All pages import from `www/shared/` for consistent styling and API calls.

## Key implementation details

**Authentication roles:**
- Admin: `POST /api/auth/login` (password → JWT, 7d) — required for all `/api/rooms/*` mutations
- Participant: `POST /api/public/rooms/:slug/join` — returns a scoped JWT for WS + file access
- Presenter role is admin-only (`POST /api/rooms/:id/enter`), never grantable from the public join flow

**Database:** All queries use prepared statements with `?N` placeholders — no string interpolation. Schema in `backend/schema.sql`, bootstrapped on every startup.

**Rate limiting:** `/api/auth/login` → 5 req/min; `/api/public/rooms/:slug/join` → 30 req/min. Uses `tower_governor` with `SmartIpKeyExtractor` (honours `X-Forwarded-For` from Caddy).

**Error handling:** `AppError::Internal` and `AppError::BadGateway` return a generic message to the client; actual error is logged server-side only.

**LiveKit:** Hand-rolled, no official Rust SDK. Token generation and RoomService calls are in `src/livekit.rs`.

## CI

GitHub Actions runs on push/PR: `cargo fmt --check`, `cargo clippy`, `cargo build`, `cargo test`, `cargo audit`. See `.github/workflows/ci.yml`.

## Useful reference docs

- `README.md` — architecture diagram, tech stack, ingest protocols
- `Streaming.md` — security model, operational gotchas, LiveKit notes, iOS pitfalls, timezone handling
- `backend/DEVELOPMENT.md` — backend dev loop details, test patterns, recommended tests
