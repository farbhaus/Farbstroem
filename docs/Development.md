# Backend development

Local dev workflow for `stream-backend`. For the overall project see the root [README](../README.md).

## Prerequisites

| Tool | Install | Why |
|---|---|---|
| Rust stable | [rustup.rs](https://rustup.rs/) | Toolchain |
| `mold` + `clang` | Linux only — see below | Linker used by `backend/.cargo/config.toml` on `x86_64-unknown-linux-gnu` |
| `watchexec` | `cargo install watchexec-cli` or `brew install watchexec` | File-watch dev loop |
| `sqlite3` CLI | `apt install sqlite3` / `brew install sqlite` | Poking at `/data/stream.db` |
| Docker + Docker Compose | [docker.com](https://www.docker.com/) | Running the full stack |

### Installing mold + clang (Linux)

`backend/.cargo/config.toml` configures mold as the linker for `x86_64-unknown-linux-gnu`. Incremental dev builds are link-bound, so this makes a noticeable difference.

```bash
# Debian / Ubuntu
sudo apt install mold clang

# Arch
sudo pacman -S mold clang

# Fedora
sudo dnf install mold clang
```

macOS and Windows are unaffected by the config — their host target triples don't match, so cargo falls back to the default linker.

## Environment

The backend reads its configuration from environment variables at startup. Copy the repo-root template and fill in secrets:

```bash
cp ../.env.example .env
```

Minimum set to boot the backend alone. All values are validated at startup and the process exits with a clear `FATAL:` message if any is missing or too short.

| Variable | Minimum | Purpose |
|---|---|---|
| `JWT_SECRET` | 32 chars | HMAC secret for admin JWTs |
| `OME_WEBHOOK_SECRET` | 32 chars | HMAC-SHA1 key for OME admission webhook verification |
| `OME_API_TOKEN` | 32 chars | Auth token for calls to the OME REST API (`OME_API_URL`) |
| `LIVEKIT_API_KEY` | required | LiveKit identifier (becomes the `iss` claim) |
| `LIVEKIT_API_SECRET` | 32 chars | HMAC secret for LiveKit access tokens |
| `ADMIN_PASSWORD` | 12 chars | Bcrypt-hashed once at startup |

Generate random secrets with `openssl rand -hex 32`.

Optional:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4001` | Axum bind port |
| `DB_PATH` | `/data/stream.db` | SQLite file |
| `DATA_PATH` | `/data` | Uploads and branding |
| `OME_API_URL` | `http://stream-ome:8081/v1` | OME admin API |
| `LIVEKIT_INTERNAL_URL` | `http://stream-livekit:7880` | LiveKit HTTP signaling |
| `LIVEKIT_URL` | `ws://localhost:7880` | WebSocket URL sent to browser clients |
| `PUBLIC_ORIGIN` | `https://stream.zemariacolor.com` | WebAuthn RP origin/ID — must match the browser origin exactly. Use `http://localhost:4001` for local dev. |

For local-only backend dev (no docker stack), override `DB_PATH` and `DATA_PATH` to somewhere writable, e.g. `./local-data/stream.db`.

## Fast dev loop

```bash
cd backend

cargo check                               # fastest — run before building
watchexec -r -e rs -- cargo run            # hot reload on .rs changes

cargo test                                 # all ~100 tests
cargo test --test rooms_public_test        # single file
cargo test --test rooms_public_test join_creates_participant  # single test
```

`cargo check` is always the right first step — it catches type errors in seconds without producing a binary.

## Tests

Integration tests live in `backend/tests/` and use [`axum-test`](https://crates.io/crates/axum-test) to exercise the router against an in-process server.

- [`tests/common/mod.rs`](../backend/tests/common/mod.rs) builds the `AppConfig` directly (rather than going through `AppConfig::from_env`), so the stricter startup validation does not affect test fixtures. Tests can use any secret length without exporting env vars.
- Each test file owns its own SQLite database in a `tempfile::TempDir`, so tests are hermetic and can run in parallel.

To debug a flaky test with logs:

```bash
RUST_LOG=debug cargo test --test rooms_public_test -- --nocapture
```

## Running the full stack

From the repo root:

```bash
docker compose up -d
```

This builds the backend image from `backend/Dockerfile` and brings up `stream-backend`, `stream-ome`, `stream-livekit`, `stream-redis`, and `stream-caddy` on the `stream-net` bridge network. The admin SPA is at `http://localhost/admin`, the viewer at `http://localhost/watch/<slug>`.

**Code changes do not hot-reload inside Docker.** The backend binary is baked into the image. Rebuild with:

```bash
docker compose up -d --build stream-backend
```

For fast iteration, run the backend locally outside Docker (`cargo run`) and keep the other services in compose.

## Release build

```bash
cargo build --release
```

Produces `target/release/stream-backend`. The [`release` profile in Cargo.toml](../backend/Cargo.toml) enables LTO + strip, giving roughly a 9 MB statically-linked binary when built against musl via the Dockerfile.

The production image uses a multi-stage build:

```
rust:1-alpine (builder, musl target)  →  alpine:3.20 + ca-certificates (runtime)
```

The resulting image is ~15 MB total.

## Where things live

| Path | Contents |
|---|---|
| [`src/main.rs`](../backend/src/main.rs) | Startup: bcrypt-hash admin password, init DB pool, spawn background tasks, mount router, `axum::serve` |
| [`src/config.rs`](../backend/src/config.rs) | `AppConfig::from_env` — fail-fast validation of secrets |
| [`src/state.rs`](../backend/src/state.rs) | `AppState` — shared `Arc` for DB pool, config, event channels, HTTP client |
| [`src/db.rs`](../backend/src/db.rs) | `r2d2_sqlite` pool + schema bootstrap from `schema.sql` |
| [`src/routes/`](../backend/src/routes/) | HTTP handlers, one file per resource |
| [`src/ws.rs`](../backend/src/ws.rs) | `/ws/room/:slug` hub — chat, presence, pointer, kick events |
| [`src/livekit.rs`](../backend/src/livekit.rs) | Hand-rolled LiveKit client (AccessToken + RoomService calls over reqwest) |
| [`src/tasks.rs`](../backend/src/tasks.rs) | Background pollers (OME state, room expiry, file cleanup) |
| [`schema.sql`](../backend/schema.sql) | Source of truth for the SQLite schema |

## Recommended tests to add

The integration suite already covers the happy paths for rooms, chat, files, and OME webhooks. The areas below are thin and should get regression coverage in a follow-up pass. Each item maps to an existing behaviour, not a new feature.

1. **Authorization boundary (viewer → presenter endpoints).** A viewer JWT hitting `POST /{slug}/conference/kick` or `/conference/mute` must return 403. Use the existing `seed_participant` helper with `role='viewer'` and assert the response code.
2. **Presenter entry flow.** `POST /api/rooms/:id/enter` with an admin JWT should produce a participant row with `role='presenter' AND is_admitted=1`. Add a negative test verifying no public endpoint can reach the same state.
3. **Kick blocks re-join by name.** After setting `is_kicked=1` for a participant, `POST /api/public/rooms/:slug/join` with the same name (case-insensitive) must return 403. Covers the check at [src/routes/rooms_public.rs](../backend/src/routes/rooms_public.rs).
4. **WS hub rejects kicked participants.** Opening `/ws/room/:slug` with a token belonging to an `is_kicked=1` participant must emit a `kicked` frame and close 1008.
5. **Webhook HMAC rejection.** `POST /api/webhook/admission` with a wrong signature → 401. Same-signature but tampered body → 401.
6. **Rate limiter.** With `STREAM_DISABLE_RATE_LIMIT` unset, fire six `POST /api/auth/login` attempts; the 6th must return 429. Requires running against the real HTTP server (not `TestServer`) so `ConnectInfo` is populated.
7. **Status endpoint shape.** `GET /api/public/rooms/:slug/status/:pid?token=…` must return `{"admitted": bool, "kicked": bool, "room_status": "…"}` for each of the three states (waiting, admitted, kicked, room-ended).
