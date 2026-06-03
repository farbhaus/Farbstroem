# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Farbstroem is a private low-latency streaming platform for color-grading review sessions. It combines OvenMediaEngine (OME) for broadcast ingest/delivery, LiveKit for participant voice/video, and a Rust/Axum backend for API and session management. The frontend is TypeScript compiled with `tsc` (no bundler, no runtime npm deps) emitted as plain ES modules.

## Commands

### Backend (Rust — `backend/`)

```bash
cargo check                              # fast type check
cargo build --release                    # production binary
cargo test                               # run all ~100 integration tests
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
# Local dev — docker-compose.override.yml is auto-merged and builds the
# backend from ./backend.
docker compose up -d                     # start all 5 services
docker compose up -d --build stream-backend  # rebuild after Rust changes
docker compose down

# Deploy hosts — pull the published backend image instead of building.
# -f selects ONLY the base file so the dev override is not auto-merged.
docker compose -f docker-compose.yml up -d
```

The backend image (`zcolor/farbstroem-backend`) is published to Docker Hub
by `.github/workflows/docker.yml` on every push to `main` (tags `:latest`
and `:sha-<short>`, linux/amd64). Deploy hosts pin a tag via
`BACKEND_TAG` in `.env`. Requires repo secrets `DOCKERHUB_USERNAME` and
`DOCKERHUB_TOKEN`.

### Environment setup

```bash
cp .env.example .env
# Fill in secrets — generate with: openssl rand -hex 32
```

**Required** (`backend/src/config.rs` panics at startup if missing or too short):

| Var | Min | Purpose |
|---|---|---|
| `JWT_SECRET` | 32 | HMAC secret for admin JWTs |
| `OME_WEBHOOK_SECRET` | 32 | HMAC-SHA1 key for OME admission webhook verification |
| `OME_SIGNED_POLICY_SECRET` | 32 | HMAC-SHA1 key for OME SignedPolicy SRT-playback tokens (`/api/watch/:slug`). Must match `<SignedPolicy><SecretKey>` in `ome/origin_conf/Server.xml`. |
| `OME_API_TOKEN` | 32 | Auth token for calls to the OME REST API |
| `LIVEKIT_API_SECRET` | 32 | HMAC secret for LiveKit access tokens |
| `ADMIN_PASSWORD` | 12 | Bcrypt-hashed once at startup |
| `LIVEKIT_API_KEY` | — | Identifier; becomes the `iss` claim |

**Optional** (with defaults):

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `4001` | Axum bind port |
| `DB_PATH` | `/data/stream.db` | SQLite file |
| `DATA_PATH` | `/data` | Uploads and branding |
| `OME_API_URL` | `http://stream-ome:8081/v1` | OME admin API |
| `LIVEKIT_INTERNAL_URL` | `http://stream-livekit:7880` | LiveKit HTTP signaling |
| `LIVEKIT_URL` | `ws://localhost:7880` | WebSocket URL sent to browser clients |
| `PUBLIC_ORIGIN` | `https://stream.zemariacolor.com` | WebAuthn RP origin/ID — must match the browser origin exactly. `http://localhost:4001` for local dev. |
| `SRT_PUBLIC_HOST` | host of `PUBLIC_ORIGIN` | SRT host returned by `/api/watch/:slug`. |
| `SRT_PUBLIC_PORT` | `9998` | SRT playback UDP port returned by `/api/watch/:slug`. |
| `SRT_LATENCY_MS` | `500` | SRT latency advertised to clients. |
| `STREAM_DISABLE_RATE_LIMIT` | unset | Set to `1` to disable rate limiting (integration tests do this). |

Generate secrets with `openssl rand -hex 32`.

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

**Services in docker-compose:** `stream-caddy` (TLS + routing), `stream-backend`, `stream-ome`, `stream-livekit` (SFU, backed by `stream-valkey`).

## Backend structure

- `src/main.rs` — startup: config, DB pool, background tasks, Axum router mount on :4001
- `src/lib.rs` — re-exports the app builder so integration tests can spin up the server in-process
- `src/config.rs` — `AppConfig::from_env`, secret length validation (fail-fast)
- `src/state.rs` — `AppState` (Arc'd, cloned into handlers)
- `src/db.rs` — R2D2 SQLite pool (8 connections), WAL mode, schema bootstrap from `schema.sql`
- `src/error.rs` — `AppError` + `IntoResponse` impl; central error → HTTP mapping
- `src/events.rs` — typed WS event payloads shared between hub and routes
- `src/auth.rs` — JWT (HS256, 7d) + bcrypt helpers
- `src/livekit.rs` — hand-rolled LiveKit client: AccessToken JWT minting + RoomService HTTP
- `src/ws.rs` — WebSocket hub, broadcast channels per room
- `src/tasks.rs` — background pollers: OME stream status, room expiry, file cleanup
- `src/routes/` — one file per resource: `rooms`, `rooms_public`, `files`, `admin_files`, `stream_keys`, `webhook`, `branding`, `metrics`, `ome`, `auth`, `admin_settings`, `rate_limit`
- `src/credentials.rs` — single-admin credential helpers: `settings` accessors, DB-or-env password resolver, TOTP, recovery codes, WebAuthn RP builder
- `tests/common/mod.rs` — shared test fixtures (in-memory DB, app setup)

## Frontend structure

TypeScript sources live under `frontend/`, compiled by `tsc` to `www/dist/` (plain ES modules, no bundler). HTML pages under `www/` import the compiled modules via `<script type="module" src="/dist/<page>/main.js">`. Static files are served directly by the Axum backend — only the type-checking step needs Node.

```bash
cd frontend && npm install        # one-time
npm run watch                     # tsc --watch, rebuilds on every save
npm run typecheck                 # CI gate
npm run build                     # production build (CI + prod host)
```

- `frontend/admin/` — admin SPA modules (`main`, `auth`, `rooms`, `stream-keys`, `files`, `branding`, `dashboard`, `settings`, `webauthn`, `types`)
- `frontend/viewer/` — viewer SPA modules (`main`, `types`, `state`, `session`, `screens`, `ws`, `player`, `livekit`/`conference`, `chat`, `pointer`, `roster`, `layout`, plus `globals.d.ts` for the CDN-loaded LiveKit/OvenPlayer globals)
- `frontend/landing/` — landing page
- `frontend/shared/` — `store.ts` (tiny reactive store), `utils.ts` (typed API wrapper, toast, formatters), `branding.ts` (read-only branding loader), `components.ts` (modal helpers)
- `www/shared/` — design system CSS (`tokens.css`, `components.css`, `utils.css`); conventions in the [Design system](#design-system) section below
- `www/{admin,viewer,landing}/index.html` — HTML markup, page-specific `<style>`, and the `<script type="module">` tag pointing at the compiled bundle
- `www/dist/` — build output (gitignored; CI / prod host produces it)

CDN-loaded runtime deps stay as `<script>` tags in the HTML: OvenPlayer, HLS.js, LiveKit client. No npm runtime deps.

## Design system

CSS tokens in [`www/shared/tokens.css`](www/shared/tokens.css), shared components in `components.css`, utilities in `utils.css`. The admin Branding API overrides `--bg/surface/text/accent/danger/green` at runtime via inline style on `:root`.

Conventions:
- Reference tokens (colors, spacing, radii, motion, z-index) — no hardcoded values in shared CSS.
- No `!important` in shared CSS. `.u-hidden` deliberately omits it so an inline `style.display` set from JS still wins.
- Class names: descriptive, hyphenated. No BEM. No CSS-in-JS.
- Z-index only from the `--z-*` scale; new layers extend the scale, not invent ad-hoc values.
- Page-specific CSS stays inline in the page's `<style>` block. Promote duplicated styles to `components.css`.

## Key implementation details

**Authentication roles:**
- Admin: `POST /api/auth/login` (password → JWT, 7d) — required for all `/api/rooms/*` mutations
- Participant: `POST /api/public/rooms/:slug/join` — returns a scoped JWT for WS + file access
- Presenter role is admin-only (`POST /api/rooms/:id/enter`), never grantable from the public join flow

**Presenter entry handoff.** Admin clicks "Enter Room" → backend creates `role='presenter', is_admitted=1` → admin JS writes `{jwt, participantId}` to `localStorage['viewer_presession_{slug}']` and opens `/watch/{slug}` in a new tab → viewer reads the presession on load, moves it into `sessionStorage['viewer_session_{slug}']`, and deletes the localStorage entry. The localStorage key exists for milliseconds. No public URL grants presenter role.

**Session isolation.** `viewer_session_{slug}` is in `sessionStorage` (per-tab, survives refresh, cleared on tab close); `viewer_name__/pass__{slug}` stay in `localStorage` (shared across tabs — intentional). `viewer_kicked_{slug}` is set on `{type:'kicked'}` or WS close 1008 and is checked at page load *before* WS connect, so a kicked viewer sees "Removed" instantly on refresh. If the sessionStorage flag is lost, the WS hub re-detects `is_kicked=1` and re-expels on reconnect.

**Database:** All queries use prepared statements with `?N` placeholders — no string interpolation. Schema in `backend/schema.sql`, bootstrapped on every startup.

**Rate limiting:** `/api/auth/login` → 5 req/min; `/api/public/rooms/:slug/join` → 30 req/min; passkey ceremonies → 30 req/min in a separate bucket so an OS prompt doesn't burn the login budget. Uses `tower_governor` with `SmartIpKeyExtractor` (honours `X-Forwarded-For` from Caddy).

**Error handling:** `AppError::Internal` and `AppError::BadGateway` return a generic message to the client; actual error is logged server-side only.

**LiveKit:** Hand-rolled, no official Rust SDK. Token generation and RoomService calls are in `src/livekit.rs`.

**Public participant status.** `GET /api/public/rooms/:slug/status/:participantId?token=…` returns `{admitted, kicked, room_status: 'scheduled|live|ended'}`. Companion SSE stream at `/api/public/rooms/:slug/waiting/events/:participantId` emits `admitted`, `kicked`, `room_ended`, `ping` — waiting-room clients drive the full state machine from SSE alone without holding a WS open.

**Moderation audit.** Kick and mute are logged via `tracing::info!` with `room_slug`, `actor_id`, `target_id` for after-the-fact audits. If LiveKit `remove_participant` fails the backend retries once after 250 ms and `error!`s on the second failure — the DB `is_kicked=1` flag and WS force-close happen first, so UI state is correct even when LiveKit is momentarily unreachable.

**Farbplay room-link SRT playback** (`src/routes/watch.rs`, GitHub #165). `GET /api/watch/:slug` lets the native SRT viewer (Farbplay) connect from a room link instead of a raw `srt://` URL. It returns `{srt: {host, port, streamid, latency}, ttlSeconds, title}` where `streamid` is `default/live/<key_token>?policy=<b64url>&signature=<b64url-hmac-sha1>`, signed with `OME_SIGNED_POLICY_SECRET` and expiring after ~30 s (`url_expire`). OME validates it via the `<SignedPolicy>` block (scoped to the SRT publisher only). 404 for unknown/expired/ended rooms or rooms without a stream key; 403 if the room is password-protected and `?password=` is missing/wrong. **Security caveat:** this gives expiry/replay-limiting, *not* secrecy — Farbstroem's OME stream name *is* the ingest stream key (`OutputStreamName=${OriginStreamName}`), so the key is in the streamid in plaintext (and is already handed to web viewers on join). Decoupling the playback identity from the ingest key is a separate follow-up.

## CI

GitHub Actions runs on push/PR (`.github/workflows/ci.yml`):
- **build** — `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo build`, `cargo test`.
- **audit** — `cargo audit` (advisory DB check).
- **frontend** — `npm run typecheck`.
- **licenses** — regenerates `THIRD_PARTY_NOTICES.md` via `cargo about` (pinned 0.9.0) and fails if the diff is non-empty.

## Useful reference docs

- `README.md` — architecture diagram, tech stack, ingest protocols

## Recommended tests to add

Thin areas in the integration suite worth regression coverage:
1. Viewer JWT → presenter endpoints (`/conference/kick`, `/conference/mute`) → 403.
2. `POST /api/rooms/:id/enter` (admin JWT) produces `role='presenter' AND is_admitted=1`; no public endpoint reaches the same state.
3. Kick blocks re-join by case-insensitive name match (`POST /api/public/rooms/:slug/join` → 403).
4. WS hub rejects kicked participants — `{type:'kicked'}` frame, close 1008.
5. Webhook HMAC: wrong signature → 401; tampered body → 401.
6. Rate limiter: 6th `/api/auth/login` in a minute → 429 (requires the real HTTP server, not `TestServer`, so `ConnectInfo` is populated).
7. Status endpoint shape: `GET /api/public/rooms/:slug/status/:pid?token=…` → `{admitted, kicked, room_status}` for each of waiting/admitted/kicked/ended.

## Gotchas

Non-obvious facts that aren't derivable from reading the code.

**LiveKit**
- `LIVEKIT_KEYS` must be `"key: secret"` with a **space after the colon**. Without it LiveKit silently boots with no auth and only logs "Could not parse keys". In docker-compose the line is quoted: `"LIVEKIT_KEYS=${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}"`.
- No upstream Rust SDK — `src/livekit.rs` is hand-rolled (AccessToken JWT + RoomService over `reqwest`) against `LIVEKIT_INTERNAL_URL` (HTTP, not WSS).
- Caddy `/livekit/*` block needs `header_up Host {upstream_hostport}` for WebSocket signaling to work through the proxy.
- Keep the UDP RTC range narrow (50000-50100) — Docker writes one iptables rule per port; wide ranges make `compose up/down` take minutes.

**OvenPlayer**
- `ovenplayer.js` does NOT bundle `hls.js` — load it separately or LLHLS fails silently.
- `controls: false` is a silent no-op. Hide the UI via CSS `.op-ui-container { display: none !important }`.
- Error/notification overlay sits OUTSIDE `.op-ui-container` — also hide `.op-message-container, .op-notification-container`.
- LLHLS + Safari + H.265 fails (Safari MSE blocks HEVC) — rely on WebRTC-first with LLHLS autoFallback.

**Player sizing**
- CSS `aspect-ratio` is unreliable in flex containers — the viewer uses JS `sizePlayer()` for exact 16:9 pixel dimensions.
- iOS orientation change: call `sizePlayer()` at 0/50/150/300/500 ms because iOS animates rotation over ~300 ms and dimensions are stale mid-transition.

**iOS Safari**
- `HTMLMediaElement.volume` is read-only — volume is hardware-only; the slider is hidden on mobile.
- Viewport meta needs `maximum-scale=1.0, user-scalable=no` to prevent auto-zoom on rotation.

**Timezones**
- `expires_at` is stored as a UTC ISO string. Admin `datetime-local` is converted both ways. Rooms created before this fix may be off by the UTC offset — re-save them in admin to correct.

**Docker / compose**
- The backend is a baked binary — `docker restart` does NOT pick up code changes. Use `docker compose up -d --build stream-backend`.
- `$` in `.env` values must be doubled (`$$`) — Compose interpolates `$VAR`.
- `stream-ome` `depends_on` `stream-backend` (`condition: service_healthy`) is load-bearing: every ingest is HMAC-verified at `/api/webhook/admission`. If the backend is down, ingests fail closed (no unauthorised streaming).
- `stream-valkey` runs Valkey (BSD-3 fork of Redis 7.2). LiveKit talks to it as a plain RESP server (see `livekit/livekit.yaml`), so the swap from upstream Redis is invisible to callers.
