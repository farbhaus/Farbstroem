---
name: Streaming Project
description: stream.zemariacolor.com — project memory for the private low-latency streaming platform. Security model, operational setup, and the non-obvious pitfalls that aren't derivable from the code.
type: reference
---

# stream.zemariacolor.com — Project Memory

- **Purpose:** private low-latency streaming platform for color grading review sessions
- **Audience:** Zé Maria (presenter) + clients/directors (viewers), small groups
- **Repo:** https://github.com/zcolor/zstream (private)

For project overview, architecture diagram, tech stack, deployment, and local dev workflow see:
- [README.md](README.md) — what it is and how to deploy it
- [backend/DEVELOPMENT.md](backend/DEVELOPMENT.md) — local dev loop

This document is focused on **what's not obvious from reading the code**: security model, operational gotchas, and the institutional knowledge that would otherwise be lost.

---

## Operational deployment (author's server)

The production server runs a host-level Caddy (systemd) in front of the containerized Caddy, so one host handles TLS for all domains on the machine:

- Host Caddy terminates TLS and proxies `stream.zemariacolor.com → localhost:8880` (container Caddy)
- Container Caddy runs plain HTTP on `:80` (mapped to host `8880`), no TLS
- `.env` sets `SITE_ADDRESS=:80` and `HTTP_PORT=8880`

This is the "behind external reverse proxy" path documented in the README. Stock standalone deployments would use `SITE_ADDRESS=stream.yourdomain.com` and let container Caddy handle TLS.

> **LiveKit is now same-origin.** It used to live on its own `lk.stream.zemariacolor.com` subdomain (host Caddy proxied it straight to `localhost:7880`). Since the container Caddy now proxies LiveKit at `/livekit/*` on the main domain (`LIVEKIT_URL=wss://<domain>/livekit`), that subdomain — its DNS record, cert, and Caddy block — is no longer needed. A live server still on the old layout keeps working until it's redeployed; drop the `lk.` block from the host Caddyfile when convenient.

### `stream-ome` depends on `stream-backend`

Looks wrong at first glance (ingest shouldn't need the web app) but is intentional: OME's `AdmissionWebhooks.ControlServerUrl` in [ome/origin_conf/Server.xml](ome/origin_conf/Server.xml) points at `http://stream-backend:4001/api/webhook/admission`, and every incoming RTMP/SRT ingest is HMAC-verified against `OME_WEBHOOK_SECRET` by [backend/src/routes/webhook.rs](backend/src/routes/webhook.rs). If the backend is down, ingests fail closed — no unauthorised streaming. The compose `depends_on` with `condition: service_healthy` is load-bearing; keep it.

---

## Conference implementation (LiveKit)

### Architecture
All admitted participants — including watch-only — connect to LiveKit to subscribe to tracks. Camera/mic participants also publish. Screen shares route to the center video overlay (not a side panel).

### Token endpoint
`GET /api/public/rooms/:slug/livekit-token?participantId=...&token=...`

- Validates participant is admitted
- Issues `AccessToken` with `roomJoin: true, room: slug, canPublish: true, canSubscribe: true`
- Metadata is `{"role": role}` where role is `presenter` or `viewer`
- The token signer (`backend/src/livekit.rs::create_access_token`) takes `role` as a typed parameter, not opaque metadata — it's structurally impossible to mint a role-less token

### Presenter entry (admin only)
The `presenter` role is **only** obtainable via `POST /api/rooms/:id/enter` (admin JWT required). The flow:

1. Admin clicks "Enter Room" → backend creates a `role=presenter, is_admitted=1` participant
2. Admin JS writes credentials to `localStorage['_presession_{slug}']` and opens `/watch/{slug}` in a new tab
3. Viewer tab reads the presession on load, immediately moves it to `sessionStorage['viewer_session_{slug}']`, and deletes the localStorage entry
4. The localStorage key exists for milliseconds only

There is no public URL that grants presenter role. The join endpoint ignores `role=presenter` from clients.

### Presenter moderation
- **Kick** — `POST /conference/kick` sets `is_kicked=1` in the DB, emits a `kicked` event (hub force-closes WS + sends `{type:'kicked'}`), and calls `LiveKitClient::remove_participant`. Rejoin blocked by name match against the same slug. Admin can unblock via `POST /api/rooms/:id/unkick/:participantId`.
- **Mute** — `POST /conference/mute` calls `LiveKitClient::mute_published_track`, a server-side forced mute of a specific track. The victim's mic UI auto-updates via the `TrackMuted` event.
- Only `role === 'presenter'` can use these endpoints. The presenter→presenter case is left to social convention; the only way to obtain presenter role is via the admin "Enter Room" flow, so the blast radius is bounded.
- Kick and mute are logged via `tracing::info!` with `room_slug`, `actor_id`, `target_id` for audit purposes. If the LiveKit `remove_participant` call fails, the backend retries once after 250ms and logs `error!` on a second failure — the DB `is_kicked=1` flag and WS force-close still happen first, so the UI state is correct even when LiveKit is momentarily unreachable.

### Presence architecture
| Data source | Used for |
|---|---|
| WS hub `participants:update` | Top-bar count, watch-only list, chat author names |
| LiveKit room events | Conference tiles (camera/mic/screen), tile creation/destruction |

### Conference permission prompt
Shown after join: Camera+Mic / Mic Only / Watch Only. Choice saved to `localStorage['conf_pref_{slug}']`, auto-applied on next visit. All choices connect to LiveKit; watch-only subscribes without publishing.

---

## Viewer layout

- **Left panel (320px):** Conference panel — self-tile + remote tiles (vertical, scrollable)
- **Center flex:** OvenPlayer (main stream), JS-sized to exact 16:9 via `sizePlayer()`
- **Right panel (320px):** Chat panel — messages, persistent Files section (fetched from REST on join, updated on `file:shared`), input row
- **Center overlay (z-index 6):** Screen share — `#screenshare-wrap` covers the player area when active
- **Pointer overlay (z-index 7):** `#pointer-overlay` — shared cursors with colored dots + name labels
- **Bottom toolbar (56px):** Camera, Mic, Screen Share, Pointer, Participants toggle, Chat toggle, Play/Pause, Volume, Resync, Fullscreen
- **Top bar (48px):** Logo, WS status, room name, participant count, live badge, Leave button

### Mobile portrait (< 640px)
- Conference panel becomes an inline horizontal strip above the video (always visible, 104px tall, tiles scroll horizontally)
- Chat becomes a full-screen overlay triggered from the toolbar
- Toolbar is two rows — row 1: Cam/Mic/Screen | Pointer/Participants/Chat; row 2: Play/Mute | Resync/Fullscreen
- Volume slider hidden — iOS Safari ignores programmatic volume
- Tile action buttons (mute/kick) always visible (no hover on touch)

### Mobile landscape (max-height 440px)
- Top bar shrinks to 32px, toolbar compact single row (32px buttons)
- Conference panel hidden by default, slides in from left as a 220px flex panel (video shrinks to fit)
- Chat slides in from right as a 260px flex panel
- Both panels are flex children, not overlays — video area resizes via `sizePlayer()` during transitions

---

## Security architecture

- **Presenter role** is exclusively granted via `POST /api/rooms/:id/enter` (admin JWT required). `presenter_key` (32-byte random hex) lives in the `rooms` table and is never served to unauthenticated clients. The public `/info` endpoint uses an explicit column list that omits it.
- **LiveKit token signer** takes `role` as a typed parameter and rejects empty roles at the boundary. Future callers cannot accidentally mint role-less tokens.
- **File MIME types** are whitelisted on upload. Downloads are served with the stored whitelisted MIME type + `X-Content-Type-Options: nosniff` + `Content-Disposition: attachment` — browsers cannot render uploaded files inline.
- **Participant auth** on file + SSE endpoints checks `participantId + token` pair, `is_admitted = 1`, and `is_kicked = 0`.
- **SQL injection** — all DB queries use `rusqlite` prepared statements with `?N` placeholders via `params![]`. No string interpolation.
- **Admin auth** — bcrypt → JWT (HS256, 7d expiry) via `jsonwebtoken`. Single admin identity. The `ADMIN_PASSWORD` env is hashed at startup into `state.admin_password_hash` (the **bootstrap** credential); if the operator sets a custom password via the Settings tab it is stored bcrypt-hashed in the `settings` table under `admin_password_hash` and that wins (`credentials::current_password_hash`). No server-side session store.
- **Optional second factor / passkeys** (managed from the admin Settings tab, `/api/admin/settings/*`, all `AdminAuth`):
  - **TOTP 2FA** — `totp-rs`, RFC 6238 (SHA1/6/30s, ±1 step). Secret + `totp_enabled` + bcrypt-hashed one-time recovery codes live in `settings` (`totp_secret` / `totp_enabled` / `totp_recovery`). When enabled, `POST /api/auth/login` with a correct password but no `totp_code` returns `200 {"totpRequired":true}` (no token); the client re-submits with a TOTP **or** recovery code (recovery codes are single-use, dropped from the list on use).
  - **Passkeys (WebAuthn)** — `webauthn-rs`, single admin user handle. Credentials in the `admin_passkeys` table (serialized `Passkey`, counter updated in place). `POST /api/auth/passkey/start` + `/finish` mint the same admin JWT and **bypass password + TOTP** (a passkey is itself a strong factor). In-flight ceremony state is held in-memory in `AppState` (TTL `CEREMONY_TTL_SECS` = 300s; lost on restart → just retry). RP origin/ID come from `PUBLIC_ORIGIN` (must match the browser origin — `https://stream.zemariacolor.com` in prod, `http://localhost:4001` for local dev).
- **Break-glass / lockout recovery** (single admin — there is no second account): clearing the relevant `settings` rows reverts to the env password with 2FA off. On the host: `sqlite3 stream/data/stream.db "DELETE FROM settings WHERE key IN ('admin_password_hash','totp_secret','totp_enabled','totp_recovery');"` then restart the backend. Deleting all rows from `admin_passkeys` removes passkey login. The `ADMIN_PASSWORD` env always works whenever no custom `admin_password_hash` row exists.
- **OpenSSL note** — `webauthn-rs` hard-depends on OpenSSL; this otherwise rustls-only musl-static build vendors it (`openssl` crate `vendored` feature, compiled statically). The Dockerfile builder stage adds `perl make gcc linux-headers` for that compile; the runtime image stays unchanged (no system libssl).
- **Secret validation at startup** (`backend/src/config.rs`): `JWT_SECRET`, `OME_WEBHOOK_SECRET`, `LIVEKIT_API_SECRET` all require ≥ 32 chars; `ADMIN_PASSWORD` ≥ 12; `LIVEKIT_API_KEY` required (no length check — it's an identifier, becomes the `iss` claim). Missing or short secrets panic at boot with a clear `FATAL:` message.
- **Rate limiting** — `POST /api/auth/login` is limited to 5 requests/minute/IP (burst 2) and `POST /api/public/rooms/:slug/join` to 30 requests/minute/IP (burst 10) via `tower_governor` with `SmartIpKeyExtractor` (honours `X-Forwarded-For` / `Forwarded` from the fronting Caddy). Over-limit requests return 429 with `retry-after`. Set `STREAM_DISABLE_RATE_LIMIT=1` to disable — integration tests do this because `axum-test::TestServer` does not populate `ConnectInfo`.
- **Error body redaction** — `AppError::Internal` and `AppError::BadGateway` log the raw `rusqlite` / `reqwest` / JWT error via `tracing::error!` but return a generic `{"error":"Internal server error"}` / `{"error":"Upstream service unavailable"}` to the client. 4xx errors keep their author-written messages (they are safe).
- **Token redaction in logs** — the request-tracing span's `uri` field redacts `token`, `presenter_key`, and `password` query params before they reach `tracing-subscriber`. Path and other query keys remain intact so logs stay useful.

---

## Session isolation

- **`sessionStorage` vs `localStorage`:** `viewer_session_{slug}` is in `sessionStorage` (per-tab, survives refresh, cleared on tab close). Name/password prefill remains in `localStorage` (shared across tabs — intentional). The separation prevents multi-tab session sharing.
- **Kicked flag:** `viewer_kicked_{slug}` is also in `sessionStorage`. Set when the WS hub sends `{type:'kicked'}` or closes with 1008. Checked at page load before any WS connection — a kicked participant sees the "Removed" screen immediately on refresh without a network round-trip.
- **Unblocking a kicked participant:** admin sets `is_kicked=0, is_admitted=1` via the unkick endpoint. Participant must close and reopen the tab (or open a new one) to clear the sessionStorage flag. Opening a new tab within the same browser window is sufficient.
- **WS hub re-kick on reconnect:** if a kicked participant's tab reconnects, the hub re-detects `is_kicked=1` and immediately re-expels, so a lost sessionStorage flag doesn't grant re-entry.

---

## Technical notes & pitfalls

### LiveKit
- **`LIVEKIT_KEYS` env var format** — must be `"key: secret"` with a **space after the colon**. In docker-compose the line must be quoted:
  ```yaml
  - "LIVEKIT_KEYS=${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}"
  ```
  Without the space, LiveKit logs "Could not parse keys" and the server comes up with no auth configured.
- **No upstream Rust LiveKit SDK** — `backend/src/livekit.rs` is a hand-rolled client: AccessToken JWT minting (`jsonwebtoken` HS256) + RoomService HTTP calls (`mute_published_track`, `remove_participant`, `delete_room`) over `reqwest`. Talks to `LIVEKIT_INTERNAL_URL` (default `http://stream-livekit:7880`) — HTTP, not WSS.
- **LiveKit subdomain** needs `header_up Host {upstream_hostport}` in Caddy for WebSocket signaling to work through the proxy.
- **Firewall:** UDP 50000-50100 and TCP 7881 must be open for LiveKit RTC.
- **Port range** — 100 UDP ports supports ~25-50 concurrent participants. Avoid large ranges (50000-60000) — Docker creates iptables rules per port, making `up/down` take multiple minutes.

### OvenPlayer
- **`ovenplayer.js` is slim** — no hls.js bundled. Must load `hls.js` separately or LLHLS fails silently.
- **`controls: false` is not a valid config option** — causes a silent error. Use CSS to hide the UI: `.op-ui-container { display: none !important }`.
- **Error overlay** — OvenPlayer renders its own on-screen error/notification overlay outside `.op-ui-container`. Hidden via `.op-message-container, .op-notification-container { display: none !important }`. The app-level "Waiting for livestream source..." overlay handles UX instead.
- **LLHLS + Safari + H.265** — OvenPlayer's LLHLS path uses MSE which Safari blocks for HEVC. Mitigated by WebRTC-first with LLHLS autoFallback.

### Player sizing
- **CSS `aspect-ratio` is unreliable in flex containers** — use JS `sizePlayer()` for exact 16:9 pixel dimensions.
- **iOS orientation change** — `sizePlayer()` must fire multiple times (0/50/150/300/500 ms) after `screen.orientation` changes because iOS animates the rotation over ~300 ms and dimensions are stale mid-transition.

### iOS
- **Volume slider is non-functional** — `HTMLMediaElement.volume` is read-only on iOS Safari; volume is hardware-only. Slider is hidden on mobile via CSS.
- **Viewport zoom on rotation** — requires `maximum-scale=1.0, user-scalable=no` in the viewport meta tag to prevent iOS auto-zoom.

### Timezones
- **`expires_at` is stored as UTC ISO string.** The admin `datetime-local` input (local time) is converted via `new Date(value).toISOString()` before sending to the backend. On load it's converted back with `new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,16)`. SQLite's `datetime('now')` returns UTC, so the comparison is correct.
- **Rooms created before this fix** may have `expires_at` stored in local time (off by UTC offset). Re-save them in the admin to correct.

### Public participant status endpoint

`GET /api/public/rooms/:slug/status/:participantId?token=…` returns:

```json
{ "admitted": bool, "kicked": bool, "room_status": "scheduled|live|ended" }
```

The matching SSE stream at `/api/public/rooms/:slug/waiting/events/:participantId` emits four event types: `admitted`, `kicked`, `room_ended`, and `ping`. Waiting-room clients can drive the full state machine from SSE alone without keeping a WS open.

### Frontend modularization

Done. Admin, viewer, and landing are TypeScript modules under [frontend/](frontend/), compiled by `tsc` to [www/dist/](www/dist/) as plain ES modules. No bundler, no runtime npm deps — `typescript` is the only devDependency. Sources are split per subsystem:

- Admin: `auth`, `rooms`, `stream-keys`, `files`, `branding`, `dashboard`, `settings`, `webauthn`, `main`, `types`.
- Viewer: `state` (central reactive store via [frontend/shared/store.ts](frontend/shared/store.ts)), `session`, `screens`, `ws` (typed discriminated `WsMessage` union + exhaustive router), `player` (OvenPlayer), `conference` (LiveKit + tile grid + cam/mic/screen + devices + presenter moderation), `chat`, `pointer`, `layout`, `main`, `types`, plus [globals.d.ts](frontend/viewer/globals.d.ts) for the CDN-loaded `OvenPlayer` and `LivekitClient` globals.
- Shared: `store`, `utils`, `branding`, `components`.

HTML pages reference the compiled JS via `<script type="module" src="/dist/<page>/main.js">`. Click handlers are delegated via `[data-action]` attributes (no `window.*` globals). The legacy `www/shared/utils.js` has been deleted; CSS tokens/components stay under [www/shared/](www/shared/) and are documented in [www/shared/README.md](www/shared/README.md).

### Docker
- **Backend is a compiled Rust binary baked into the image** (multi-stage: `rust:1-alpine` builder → `alpine:3.20` runtime, statically linked against musl). `docker restart` does NOT pick up code changes — must `docker compose up -d --build stream-backend`.
- **Healthchecks.** All five services have `healthcheck:` blocks in [docker-compose.yml](docker-compose.yml). Dependents use long-form `depends_on: { <svc>: { condition: service_healthy } }` so the stack waits for readiness, not just container start. `stream-ome` waits for `stream-backend` (see above); `stream-caddy` waits for both `stream-backend` and `stream-ome`; `stream-livekit` waits for `stream-redis`. `stream-backend` has a `/healthz` endpoint that deliberately does not touch the DB pool — a stuck pool should leave the service *up* so it can recover, not loop-restart.
- **First build is slow** — the Dockerfile pre-fetches and compiles dependencies against a stub `main.rs` so subsequent builds only recompile the application crate.
- **`$` in `.env`** — Docker Compose processes `$` in env_file values. Use `$$` to escape.
- **Startup race fix** — `axum::serve` is awaited only after the `bcrypt::hash` task (run in `tokio::task::spawn_blocking`) returns, so the listener never accepts before the admin password hash is ready.
- **Caddy behind proxy** — set `SITE_ADDRESS=:80` to disable auto-HTTPS when behind a host-level reverse proxy. Using a real domain triggers Let's Encrypt provisioning which fails or conflicts.
