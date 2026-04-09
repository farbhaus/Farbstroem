---
name: Streaming Project
description: stream.zemariacolor.com — architecture, LiveKit conference, OME broadcast, chat, file sharing, presenter moderation for private streaming platform
type: reference
---

# stream.zemariacolor.com — Project Memory

Purpose: Private low-latency streaming platform for color grading review sessions.
Audience: Zé Maria (presenter) + clients/directors (viewers), small groups.
Repo: https://github.com/zcolor/zstream (private)

---

## Inspiration

- Louper: https://www.louper.io/
- Remoteroom: https://remoteroom.io/features
- Chromatic: https://github.com/davidtorcivia/chromatic
- Colourstream: https://github.com/chaos-dotcom/colourstream

--- 

## Main Sources (reference when in doubt)

 - OvenMediaEngine: https://github.com/OvenMediaLabs/OvenMediaEngine
 - OvenPlayer: https://github.com/OvenMediaLabs/OvenPlayer
 - LiveKit: https://github.com/livekit/livekit — SFU for conference layer
 - LiveKit JS Client SDK: https://github.com/livekit/client-sdk-js — browser-side conference
 - LiveKit Server SDK (Node): https://github.com/livekit/server-sdk-js — token generation, room service

---

## Main Goals

Create a flexible livestreaming collaboration platform that can do the following: 

1. Ingest Protocol: SRT, WHIP and RTMP
2. Viewer Delivery: WebRTC and LLHLS — per-room choice
3. Features:
    - Waiting room + room passwords
    - Voice and video conference (LiveKit SFU)
    - Chat
    - Drawing / laser pointer overlay
    - Watermarking (maybe)
    - File sharing in chat (temp, session-only)
    - Screen Sharing (routed to center video area)
    - Presenter moderation (kick / mute participants)
    - Conference only Room without streaming for meetings

---

## Architecture

```
Main stream (OBS → OME → OvenPlayer):
  OBS (SRT/RTMP/WHIP) → OvenMediaEngine → OvenPlayer (WebRTC/LLHLS)

Conference (LiveKit SFU):
  Browser → LiveKit JS SDK → livekit-server → LiveKit JS SDK (remote tiles)

Screen sharing:
  Browser → LiveKit SDK → center video overlay (z-index 6, above offline screen)

Chat / presence / files:
  Browser ↔ WebSocket hub (Rust/Axum, src/ws.rs) — participants:update, chat:message, file:shared, pointer:move/hide
```

**Containers (docker-compose.yml) — bridge network `stream-net`:**
- `stream-caddy` — Caddy 2 Alpine (TLS + routing `/live/*` to OME, everything else to backend)
- `stream-ome` — OvenMediaEngine (broadcast ingest + delivery)
- `stream-backend` — Rust/Axum + SQLite (port 4001, serves static files via `tower-http` `ServeDir`)
- `stream-livekit` — LiveKit SFU server (port 7880, RTC 50000-50100/UDP, 7881/TCP)
- `stream-redis` — Redis 7 Alpine (required by LiveKit)

**Networking:**
- All services on bridge network `stream-net`, reference each other by container name
- Container Caddy listens on `${HTTP_PORT:-80}` / `${HTTPS_PORT:-443}` (configurable for behind-proxy setups)
- `SITE_ADDRESS` env var controls Caddy domain: `localhost` (local dev), `yourdomain.com` (standalone TLS), `:80` (behind external proxy)
- LiveKit ports 7880/7881/50000-50100 mapped to host for WebRTC media
- OME ingest ports mapped to host: 1935 (RTMP), 9999/UDP (SRT), 10000-10009/UDP (ICE), 3478 (TURN)

**Author's server deployment:**
- Host Caddy (systemd) handles TLS for all domains, proxies `stream.zemariacolor.com → localhost:8880` and `lk.stream.zemariacolor.com → localhost:7880`
- Container Caddy runs plain HTTP on `:80` (mapped to host 8880), no TLS
- `.env` sets `SITE_ADDRESS=:80`, `HTTP_PORT=8880`

---

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Broadcast engine | OvenMediaEngine | Multi-protocol, H.265 passthrough, no GPU |
| Conference SFU | LiveKit | Rooms, track management, screen sharing, moderation API |
| Backend | Rust + Axum 0.7 | Port 4001; `tokio` runtime; integration tests via `axum-test` |
| Database | SQLite (WAL) via `rusqlite` + `r2d2` pool | `/data/stream.db` (mounted volume); schema in `backend/schema.sql` |
| Frontend (admin) | Vanilla JS SPA | `/www/admin/index.html` |
| Frontend (viewer) | Vanilla JS + OvenPlayer + LiveKit JS SDK | `/www/viewer/index.html` |
| Reverse proxy | Caddy (container) | Proxies `/live/*` to OME:3333, everything else to backend; `SITE_ADDRESS` env var for domain/TLS |

---

## Ingest Protocols

| Protocol | Port | Use Case |
|---|---|---|
| SRT | 9999/UDP | Primary — H.265 passthrough, reliable |
| RTMP | 1935/TCP | Universal encoder support |
| WHIP | via Caddy `/live/*` | OBS + browser |

- **SRT streamid format:** `default/live/{stream-key}` — OBS: `srt://stream.zemariacolor.com:9999?streamid=default/live/YOUR_KEY`
- **RTMP URL:** `rtmp://stream.zemariacolor.com:1935/live` with stream key as stream name
- **H.265 passthrough:** SRT/WHIP → OME → WebRTC/LLHLS, no transcoding, no GPU

---

## Viewer Delivery

| Mode | Protocol | Latency | Use Case |
|---|---|---|---|
| WebRTC | OME WebRTC | Sub-second | Realtime color accurate sessions |
| LLHLS | Low-Latency HLS | 2–5s | Color accurate HDR sessions (investigate if possible) |

WebRTC or LLHLS is a per-room setting defined in the backend.

---

## Caddy Config (container — `caddy/Caddyfile`)

```caddy
{$SITE_ADDRESS:localhost} {
    encode gzip zstd
    handle /live/* {
        reverse_proxy stream-ome:3333 {
            transport http { versions 1.1 }
            flush_interval -1
        }
    }
    reverse_proxy stream-backend:4001
}
```

Backend serves static files via `tower-http` `ServeDir` (`/admin` → admin SPA via `nest_service`, fallback service → viewer SPA). Caddy only routes `/live/*` to OME and everything else to the backend.

---

## File Structure

```
/opt/zemaria/stream/
├── docker-compose.yml        ← services: stream-caddy, stream-ome, stream-backend, stream-livekit, stream-redis (bridge network)
├── caddy/Caddyfile           ← Container Caddy config (SITE_ADDRESS env var for domain)
├── .env                      ← All secrets + domain config (gitignored)
├── .env.example              ← Template for .env (committed)
├── livekit/livekit.yaml      ← LiveKit server config (keys via LIVEKIT_KEYS env var, no secrets in file)
├── ome/origin_conf/Server.xml
├── backend/
│   ├── Cargo.toml            ← axum 0.7, tokio, rusqlite, r2d2, jsonwebtoken, bcrypt, reqwest (rustls)
│   ├── Cargo.lock
│   ├── Dockerfile            ← multi-stage: rust:1-alpine builder → alpine:3.20 runtime (musl static binary)
│   ├── schema.sql            ← SQLite DDL applied on init_pool()
│   ├── src/
│   │   ├── main.rs           ← startup: bcrypt hash admin pw, init pool, spawn pollers + ws listeners, mount static dirs, axum::serve
│   │   ├── lib.rs            ← module declarations
│   │   ├── config.rs         ← AppConfig::from_env() — fails fast on missing JWT_SECRET / ADMIN_PASSWORD / OME_WEBHOOK_SECRET
│   │   ├── state.rs          ← AppState (db pool, events, config, http_client, admin_password_hash) — Arc-shared
│   │   ├── db.rs             ← r2d2_sqlite pool init, schema bootstrap
│   │   ├── error.rs          ← AppError + IntoResponse impl
│   │   ├── events.rs         ← broadcast channels: room_ended, room_pending, kicked, file_shared, …
│   │   ├── auth.rs           ← JWT encode/decode (jsonwebtoken HS256), bcrypt verify
│   │   ├── livekit.rs        ← LiveKitClient: AccessToken minting + RoomService HTTP calls (mute/remove/delete-room)
│   │   ├── tasks.rs          ← spawn_ome_poller (30s), spawn_expiry_poller (60s), spawn_room_ended_cleanup, spawn_weekly_cleanup
│   │   ├── ws.rs             ← /ws/room/:slug; broadcasts participants:update, chat:message, file:shared, pointer:move/hide; chat persisted; history on auth:ok
│   │   └── routes/
│   │       ├── mod.rs        ← build_router(state) — nests all sub-routers under /api
│   │       ├── auth.rs       ← login + logout (stateless JWT)
│   │       ├── rooms.rs      ← admin room CRUD; DELETE emits room:ended + cleans LiveKit before DB delete
│   │       ├── rooms_public.rs ← join, waiting (SSE), admission, livekit-token, conference/kick, conference/mute
│   │       ├── files.rs      ← upload, list, download; axum multipart; cleanup on room:ended + weekly
│   │       ├── branding.rs   ← logo + bg upload/serve/delete; files in /data/branding/; mime in settings table
│   │       ├── stream_keys.rs
│   │       ├── webhook.rs    ← OME admission webhook (HMAC-SHA1 signature verify, stream key validation)
│   │       └── ome.rs        ← /api/ome/stats proxy
│   └── tests/                ← integration tests (axum-test): auth, rooms, rooms_public, stream_keys, files, ome, webhook, branding
└── www/
    ├── admin/index.html      ← Admin SPA (rooms, stream keys, waiting room, branding tab)
    └── viewer/index.html     ← Viewer page (OvenPlayer + LiveKit conference + chat + files section + screen sharing)
```

---

## Database Schema

Source of truth: `backend/schema.sql` (applied on startup via `db::init_pool`).

```sql
CREATE TABLE rooms (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    presenter_key TEXT,  -- 32-byte hex; client must present to obtain presenter role
    delivery_mode TEXT NOT NULL DEFAULT 'webrtc',
    waiting_room INTEGER NOT NULL DEFAULT 0,
    expires_at DATETIME,  -- stored as UTC ISO string
    status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'live' | 'ended'
    stream_key_id TEXT REFERENCES stream_keys(id) ON DELETE SET NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME, ended_at DATETIME
);
CREATE TABLE stream_keys (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, key_token TEXT UNIQUE NOT NULL,
    room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE participants (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer',  -- 'presenter' | 'viewer'
    is_admitted INTEGER NOT NULL DEFAULT 0,
    is_kicked INTEGER NOT NULL DEFAULT 0,  -- kicked by presenter, blocks rejoin by name
    token TEXT UNIQUE,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE session_files (  -- files stored at /data/uploads/{roomId}/
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    uploader_id TEXT REFERENCES participants(id) ON DELETE SET NULL,
    original_name TEXT NOT NULL, stored_path TEXT NOT NULL,
    mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE chat_messages (  -- session-scoped; deleted on room:ended
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE settings (  -- key-value store for platform config (e.g. branding mime types)
    key TEXT PRIMARY KEY, value TEXT NOT NULL
);
-- Indexes: rooms(slug, status, stream_key_id), stream_keys(key_token, room_id),
--         participants(room_id, token), chat_messages(room_id, created_at)
```

---

## API Routes

### Public (participant token auth)
- `GET  /api/public/rooms/:slug/info` — room metadata
- `POST /api/public/rooms/:slug/join` — validate password, create participant, return token + role
- `GET  /api/public/rooms/:slug/status/:participantId?token=` — admission status poll (token required)
- `GET  /api/public/rooms/:slug/waiting/events/:id?token=` — SSE for waiting room (token validated before stream opens)
- `GET  /api/public/rooms/:slug/livekit-token` — LiveKit access token (admitted only)
- `POST /api/public/rooms/:slug/conference/kick` — presenter kicks + bans participant (is_kicked=1, WS disconnect, LiveKit removal)
- `POST /api/public/rooms/:slug/conference/mute` — presenter mutes/unmutes participant's track (server-side)
- `POST /api/webhook/admission` — OME Admission Webhook

### Auth
- `POST /api/auth/login` — password → JWT
- `POST /api/auth/logout` — returns `{ ok: true }` (stateless JWT)

### Admin (JWT required)
- `GET/POST /api/rooms`, `GET/PUT/DELETE /api/rooms/:id`, `POST /api/rooms/:id/end`
  - `DELETE /api/rooms/:id` — emits `room:ended` (kicks WS participants, triggers file/chat cleanup), deletes LiveKit room, then removes from DB
- `GET/POST/DELETE /api/stream-keys`
- `GET /api/rooms/:id/waiting`, `POST /api/rooms/:id/admit/:participantId`, `POST /api/rooms/:id/admit-all`
- `GET /api/rooms/:id/kicked`, `POST /api/rooms/:id/unkick/:participantId` — kicked list + unblock
- `POST /api/rooms/:id/enter` — admin enters room as presenter; creates a `role=presenter, is_admitted=1` participant, returns `{participantId, token, slug, deliveryMode, streamKey}`. Admin UI stores credentials in localStorage as `_presession_{slug}`, opens viewer tab which consumes them immediately into sessionStorage.
- `GET /api/ome/stats`
- `POST /api/admin/branding/logo|bg` — upload custom logo or background image (max 5 MB); stored in `/data/branding/`
- `DELETE /api/admin/branding/logo|bg` — remove custom asset

### Public branding
- `GET /api/branding` — returns `{ hasLogo: bool, hasBg: bool }`
- `GET /api/branding/logo`, `GET /api/branding/bg` — serve custom assets with correct Content-Type

### WebSocket (`/ws/room/:slug`)
- Auth: first message must be `{ type: 'auth', participantId, token }`
- After `auth:ok`: server sends `{ type: 'chat:history', messages: [...] }` (last 50, for rejoin persistence)
- Hub broadcasts: `{ type: 'participants:update', participants: [{id, name, role}] }`
- Chat: `{ type: 'chat:message', text }` → broadcast `{ type: 'chat:message', id, participantId, name, role, text, ts }` — also persisted to `chat_messages` table; deleted on `room:ended`
- Files: upload via REST → broadcast `{ type: 'file:shared', id, participantId, uploaderName, role, name, size, mime, ts }`
- Room status: `room:live`, `room:pending`, `room:ended`
- Kick: `{ type: 'kicked' }` — sent to victim before WS close; viewer shows "Removed" screen and sets `viewer_kicked_{slug}` in `sessionStorage` so the kicked screen persists across refreshes within the same tab
- Pointer: `{ type: 'pointer:move', x, y }` → broadcast `{ type: 'pointer:move', participantId, name, x, y }` (normalized 0-1 coords, ~30fps throttled)
- Pointer hide: `{ type: 'pointer:hide' }` → broadcast `{ type: 'pointer:hide', participantId }` (on mouseleave/touchend/toggle off)

---

## Conference Implementation (LiveKit)

**Architecture:** All admitted participants (including watch-only) connect to LiveKit to subscribe to tracks. Camera/mic participants also publish their tracks. Screen shares route to the center video overlay.

**LiveKit token endpoint:** `GET /api/public/rooms/:slug/livekit-token?participantId=...&token=...`
- Validates participant is admitted
- Issues AccessToken with `roomJoin: true, room: slug, canPublish: true, canSubscribe: true`
- Metadata includes `{ role }` — used client-side for presenter detection

**Presenter entry (admin):**
- Admin clicks "Enter Room" → `POST /api/rooms/:id/enter` (JWT required) — creates `role=presenter, is_admitted=1` participant, returns credentials
- Admin JS writes `_presession_{slug}` to localStorage, opens `/watch/{slug}` in new tab
- Viewer tab consumes the presession on load: moves it to sessionStorage as `viewer_session_{slug}`, then proceeds to `showApp()` as presenter with no join form
- This is the only way to obtain presenter role; there is no public URL that grants it

**Presenter moderation:**
- Kick: `POST /conference/kick` → sets `is_kicked=1` in DB, emits `kicked` event (hub force-closes WS + sends `{type:'kicked'}`), calls `LiveKitClient::remove_participant`. Fully expels participant; rejoin blocked by name match. Admin can unblock via `POST /api/rooms/:id/unkick/:participantId`.
  - Kicked screen persists across tab refreshes via `viewer_kicked_{slug}` in `sessionStorage`. Cleared only when tab is closed. Hub also sends `{type:'kicked'}` on reconnect attempt (if participant tries to refresh into the app, hub detects `is_kicked=1` and re-expels).
- Mute: `POST /conference/mute` → `LiveKitClient::mute_published_track` — server-side forced mute of specific track. Muted participant's local UI auto-updates (mic button reflects muted state via `TrackMuted` event + `syncLocalMuteState`).
- Only `role === 'presenter'` can use these; presenters cannot target other presenters
- Buttons appear on hover (desktop) or always visible (mobile) on remote tiles

**Presence architecture:**
| Data source | Used for |
|---|---|
| WS hub `participants:update` | Top-bar count, watch-only list, chat author names |
| LiveKit room events | Conference tiles (camera/mic/screen), tile creation/destruction |

**Conference permission prompt:** shown after join — Camera+Mic / Mic Only / Watch Only. Choice saved to `localStorage` as `conf_pref_{slug}`, auto-applied on next visit. All choices connect to LiveKit (watch-only subscribes without publishing).

---

## Viewer Layout

- **Left panel (320px):** Conference panel — self-tile + remote tiles (vertical, scrollable)
- **Center flex:** OvenPlayer (main stream) — JS-sized to exact 16:9 via `sizePlayer()`
- **Right panel (320px):** Chat panel — messages area, persistent Files section (fetched from REST on join, updated on `file:shared`), progress bar, input row
- **Center overlay (z-index 6):** Screen share — `#screenshare-wrap` covers player area when active
- **Pointer overlay (z-index 7):** `#pointer-overlay` — shared cursors with colored dots + name labels; `pointer-events: none` until toggled active
- **Bottom toolbar (56px):** Camera, Mic, Screen Share, Pointer, Participants toggle, Chat toggle, Play/Pause, Volume, Resync, Fullscreen
- **Top bar (48px):** Logo, WS status, room name, participant count, live badge, Leave button

**Mobile portrait (< 640px):**
- Conference panel: inline horizontal strip above video (always visible, 104px tall, tiles scroll horizontally)
- Chat: full-screen overlay from toolbar button
- Toolbar: two rows — Row 1: Cam/Mic/Screen | Pointer/Participants/Chat, Row 2: Play/Mute | Resync/Fullscreen (volume slider hidden — iOS ignores programmatic volume)
- Join/waiting boxes: responsive width
- Tile action buttons (mute/kick): always visible (no hover on touch)
- Admin UI: responsive nav, stacked cards, single-column forms

**Mobile landscape (max-height 440px):**
- Top bar shrinks to 32px, toolbar compact single row (32px buttons)
- Conference panel: hidden by default, slides in from left as 220px flex panel (video shrinks to fit)
- Chat: slides in from right as 260px flex panel (video shrinks to fit)
- Both panels are flex children, not overlays — video area resizes via `sizePlayer()` during transitions

---

## Feature Progress

### Phase 1 — Core Streaming ✅
- [x] OvenMediaEngine Docker setup + config
- [x] OME Admission Webhook (stream key validation)
- [x] Room management (create, edit, delete, expiry)
- [x] Stream key management
- [x] Viewer delivery mode per room (WebRTC vs LLHLS)
- [x] Waiting room (admit/deny, SSE + polling fallback)
- [x] Room passwords (bcrypt)
- [x] Presenter vs viewer links
- [x] Docker Compose, Caddy config, secrets
- [x] Admin SPA
- [x] OvenPlayer viewer page

### Phase 2 — Collaboration ✅
- [x] Text chat (WebSocket, per-room, session-scoped)
- [x] File sharing in chat (temp, session-only, auto-cleanup on room:ended + weekly)
- [x] Shared pointer overlay (replaces drawing canvas — colored cursors with name labels, mouse + touch)

### Phase 3 — Conference ✅ (LiveKit migration complete)
- [x] LiveKit SFU replacing WHIP/OME conference (2026-04)
- [x] LiveKit containers (livekit-server + redis) in docker-compose
- [x] LiveKit token endpoint with role metadata
- [x] Camera, microphone, screen sharing via LiveKit JS SDK
- [x] Screen share routed to center overlay (not side panel)
- [x] Watch-only participants connect to LiveKit (subscribe without publishing)
- [x] Presenter moderation: kick + mute via `LiveKitClient` (RoomService HTTP API)
- [x] Conference permission prompt + localStorage preference per room
- [x] Remote tiles with camera/mic state indicators
- [x] Mic-only tile (dark tile with mic icon)
- [x] Responsive mobile conference strip
- [x] WS hub simplified: broadcasts participants:update (id, name, role only)

### Phase 4 — Polish (partial)
- [x] Mobile layout (conference strip, responsive admin)
- [x] Mobile landscape layout (flex panels, compact toolbar, orientation-aware sizePlayer)
- [x] Mobile portrait two-row toolbar with logical grouping
- [x] LLHLS autoFallback for main player
- [ ] Watermarking
- [x] OME stats dashboard in admin
- [x] Room auto-cleanup on expiry (60s interval in `tasks::spawn_expiry_poller`; sets status='ended', emits room:ended event, cleans LiveKit)
- [x] Landing page at `/`
- [x] Resync button (tears down and reinitializes player)
- [x] Custom branding: logo + background image upload in admin (global, stored in /data/branding/, max 5 MB; no default — blank if not set)
- [x] Chat persistence across rejoin (last 50 messages sent on auth:ok; deleted on room:ended)
- [x] Persistent Files section in chat panel (fetched from REST on join; survives page reload)
- [x] File upload progress bar in chat
- [x] Exit room button (Leave in top bar → "You left" screen with Rejoin)
- [x] OvenPlayer on-screen error overlay hidden via CSS
- [x] Room delete kicks all WS participants and cleans up LiveKit before DB removal
- [x] expires_at stored and compared in UTC (admin datetime-local input converted on save/load)

### Phase 4b — Security & Session Bug Fixes ✅
- [x] Canonical `/watch/{slug}` URL enforcement — direct room slug URLs redirect to `/watch/` prefix
- [x] Rate limiter moved off GET `/info` onto POST `/join` only — prevents false "Room not found" on refresh
- [x] `viewer_session_{slug}` moved from `localStorage` to `sessionStorage` — per-tab isolation; prevents multi-tab session sharing
- [x] Removed `wasAdmitted` auto-bypass logic from join route — each new tab/browser creates a fresh participant
- [x] Removed auto-join on `savedName` — new tabs always show the join form, never bypass waiting room/password
- [x] Watch-only participant kick: delegated click listener moved to `#left-panel` (parent of both `#conf-tiles` and `#conf-viewers`) — fixes no-op kick buttons for watch-only participants
- [x] Kicked screen persists across refreshes — `viewer_kicked_{slug}` flag in `sessionStorage`; hub sends `{type:'kicked'}` on any reconnect attempt by a kicked participant
- [x] Kicked screen cannot be overridden by `ws.onclose` 1008 handler — guard checks kicked screen visibility before showing join form

### Phase 4c — Pentester Audit Fixes ✅
- [x] **Critical: Presenter role bypass** — `req.body.role` was trusted blindly; anyone could add `?role=presenter` to URL and get presenter privileges. Fixed by adding `presenter_key` (32-byte random hex) to each room in DB. Join endpoint validates key server-side; wrong/missing → silently joins as viewer. Presenter role is now only obtainable via `POST /api/rooms/:id/enter` (admin JWT required).
- [x] **Medium: Kicked participants could upload/download files** — `participant_auth` in `routes/files.rs` checked `is_admitted=1` but not `is_kicked=0`. Fixed.
- [x] **Medium: Client-supplied MIME type served on downloads** — `req.file.mimetype` comes from the multipart header (fully client-controlled). A malicious participant could upload a file with `Content-Type: text/html` and it would be served as HTML — stored XSS vector. Fixed by whitelisting safe MIME types on upload; unknown types stored and served as `application/octet-stream`. Added `X-Content-Type-Options: nosniff` to download response.
- [x] **Low: Unauthenticated waiting room SSE/poll** — `GET /:slug/waiting/events/:participantId` and `GET /:slug/status/:participantId` had no token validation. Anyone knowing a participantId (UUID) could monitor admission status indefinitely. Fixed by requiring `?token=` on both endpoints; validated against DB before SSE stream opens.

### Phase 5 — Containerization ✅ (self-contained docker-compose)
- [x] Caddy containerized with env-based domain (`SITE_ADDRESS`)
- [x] Bridge network replacing `network_mode: host`
- [x] All inter-service refs use container names (no more localhost/127.0.0.1)
- [x] Single `.env` for all secrets + config (replaces `backend/secrets.env` + compose `.env`)
- [x] `.env.example` template for public distribution
- [x] Frontend protocol-aware (http/https, ws/wss based on `location.protocol`)
- [x] Frontend domain-agnostic (`location.origin`/`location.host` instead of hardcoded domain)
- [x] LiveKit keys via `LIVEKIT_KEYS` env var (no secrets in committed files)
- [x] Reduced LiveKit UDP range (50000-50100) for fast container start/stop
- [x] Works standalone (`docker compose up`) and behind external reverse proxy

### Phase 6 — Rust Backend Port ✅
- [x] Backend rewritten from Node.js/Express → Rust + Axum 0.7 (`stream-backend` crate)
- [x] SQLite via `rusqlite` + `r2d2` connection pool (replaces `better-sqlite3`)
- [x] Static files served by `tower-http` `ServeDir` (replaces `express.static`)
- [x] Multipart uploads via `axum::extract::Multipart` (replaces `multer`)
- [x] Hand-rolled LiveKit client in `src/livekit.rs` — AccessToken JWT minting + RoomService HTTP calls (replaces `livekit-server-sdk`)
- [x] Background tasks (`tokio::spawn`) for OME poller, expiry poller, room-ended cleanup, weekly cleanup
- [x] WebSocket hub in `src/ws.rs` — same protocol (auth → participants:update / chat / files / pointer / kick / room status), persisted in `chat_messages`
- [x] Config validation in `AppConfig::from_env()` — fails fast on missing `JWT_SECRET` (must be ≥32 chars), `ADMIN_PASSWORD`, `OME_WEBHOOK_SECRET`
- [x] Multi-stage Dockerfile (`rust:1-alpine` → `alpine:3.20`) producing a static musl binary
- [x] Integration test suite in `backend/tests/` using `axum-test` (auth, rooms, rooms_public, stream_keys, files, ome, webhook, branding)

---

## Technical Notes & Pitfalls

### LiveKit
- **`LIVEKIT_KEYS` env var format:** Must be `"key: secret"` (space after colon). In docker-compose, the line must be quoted: `"LIVEKIT_KEYS=${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}"`. Without the space, LiveKit logs "Could not parse keys".
- **No upstream Rust LiveKit SDK** — `backend/src/livekit.rs` is a hand-rolled client: AccessToken JWT minting (`jsonwebtoken` HS256) + RoomService HTTP calls (`mute_published_track`, `remove_participant`, `delete_room`) over `reqwest`. Talks to `LIVEKIT_INTERNAL_URL` (defaults to `http://stream-livekit:7880`) — HTTP, not WSS.
- **LiveKit subdomain** must have `header_up Host {upstream_hostport}` in Caddy for WebSocket connections.
- **Firewall:** UDP 50000-50100 and TCP 7881 must be open for LiveKit RTC.
- **Port range:** 100 UDP ports (50000-50100) supports ~25-50 concurrent participants. Avoid large ranges (50000-60000) — Docker creates iptables rules per port, causing multi-minute start/stop.

### OvenPlayer
- **`ovenplayer.js` is slim** — no hls.js bundled. Must load `hls.js` separately or LLHLS fails silently.
- **`controls: false` is not a valid config option** — causes silent error. Use CSS to hide UI: `.op-ui-container { display: none !important }`.
- **Error overlay** — OvenPlayer renders its own on-screen error/notification overlay outside `.op-ui-container`. Hidden via `.op-message-container, .op-notification-container { display: none !important }`. The app-level "Waiting for livestream source..." overlay handles UX instead.
- **LLHLS + Safari + H.265:** OvenPlayer's LLHLS path uses MSE which Safari blocks for HEVC. Mitigated by WebRTC-first with LLHLS autoFallback.

### Player Sizing
- **CSS `aspect-ratio` is unreliable in flex containers** — use JS `sizePlayer()` for exact 16:9 pixel dimensions.
- **iOS orientation change** — `sizePlayer()` must fire multiple times (0/50/150/300/500ms) after `screen.orientation` change because iOS animates the rotation over ~300ms and dimensions are stale mid-transition.

### iOS
- **Volume slider is non-functional on iOS** — `HTMLMediaElement.volume` is read-only on iOS Safari; volume is hardware-only. Slider is hidden on mobile via CSS.
- **Viewport zoom on rotation** — requires `maximum-scale=1.0, user-scalable=no` in viewport meta tag to prevent iOS auto-zoom.

### Timezones
- **`expires_at` is stored as UTC ISO string** — admin `datetime-local` input (local time) is converted via `new Date(value).toISOString()` before sending to the backend. On load, converted back with `new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,16)`. SQLite's `datetime('now')` returns UTC, so the comparison is correct.
- **Rooms created before this fix** may have `expires_at` stored in local time (off by UTC offset). Re-save them in the admin to correct.

### Security Architecture
- **Presenter role** is exclusively granted via `POST /api/rooms/:id/enter` (admin JWT required). The join endpoint ignores any client-supplied `role=presenter` without a valid `presenter_key` (stored in rooms table, never exposed publicly). Incorrect or missing key → silent demotion to viewer.
- **`presenter_key`** is a 32-byte random hex value generated at room creation. It lives in the DB and is included in admin-only `SELECT r.*` responses (behind JWT). It is never served to unauthenticated clients (the public `/info` endpoint uses an explicit column list).
- **Admin "Enter Room"** flow: `POST /api/rooms/:id/enter` → credentials written to `localStorage['_presession_{slug}']` → viewer tab opens, immediately reads and deletes the entry, moves to `sessionStorage`. The localStorage key exists for milliseconds only.
- **File MIME types** are validated against a whitelist on upload. Downloads are served with the stored (whitelisted) MIME type + `X-Content-Type-Options: nosniff` + `Content-Disposition: attachment` — browsers cannot render them inline.
- **Participant auth** on file and SSE endpoints: all check `participantId + token` pair against DB, `is_admitted = 1`, and `is_kicked = 0`.
- **SQL injection**: all DB queries use `rusqlite` prepared statements with `?N` placeholders via `params![]`. No string interpolation.
- **Admin auth**: bcrypt password → JWT (HS256, 7d expiry) via `jsonwebtoken`. Password hashed at startup (in a `spawn_blocking` task) and plaintext is read from env once then dropped. No server-side session store.

### Session Isolation
- **`sessionStorage` vs `localStorage` for participant sessions:** `viewer_session_{slug}` is stored in `sessionStorage` (per-tab, survives refresh, cleared on tab close). Name/password prefill remains in `localStorage` (shared across tabs, intentional).
- **Kicked flag:** `viewer_kicked_{slug}` stored in `sessionStorage`. Set when `{type:'kicked'}` WS message received or when hub closes with 1008 after detecting `is_kicked=1`. Checked at page load before attempting any WS connection — kicked participant sees the "Removed" screen immediately on refresh without a network round-trip.
- **Unblocking a kicked participant:** Admin sets `is_kicked=0, is_admitted=1` via unkick endpoint. Participant must close and reopen the tab (or open a new one) to clear the sessionStorage flag and attempt rejoin.

### Docker
- **Backend is a compiled Rust binary baked into the image** (`backend/Dockerfile` is multi-stage: `rust:1-alpine` builder → `alpine:3.20` runtime, statically linked against musl). `docker restart` does NOT pick up code changes — must `docker compose up -d --build stream-backend`.
- **First build is slow** — the Dockerfile pre-fetches and compiles dependencies against a stub `main.rs` so subsequent builds only recompile the application crate.
- **`$` in `.env`** — Docker Compose processes `$` in env_file values. Use `$$` to escape.
- **Startup race fix:** `axum::serve` is awaited only after the `bcrypt::hash` task (run in `tokio::task::spawn_blocking`) returns, so the listener never accepts before the admin password hash is ready.
- **Large UDP port ranges** — mapping 50000-60000 (10K ports) causes 5+ min container start/stop. Use 50000-50100 (100 ports).
- **Caddy behind proxy** — set `SITE_ADDRESS=:80` to disable auto-HTTPS when behind a host-level reverse proxy. Using a real domain triggers Let's Encrypt cert provisioning which fails/conflicts.
