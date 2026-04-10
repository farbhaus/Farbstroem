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

For local-only backend dev (no docker stack), override `DB_PATH` and `DATA_PATH` to somewhere writable, e.g. `./local-data/stream.db`.

## Fast dev loop

```bash
cd backend

cargo check                               # fastest — run before building
watchexec -r -e rs -- cargo run            # hot reload on .rs changes

cargo test                                 # all ~70 tests
cargo test --test rooms_public_test        # single file
cargo test --test rooms_public_test join_creates_participant  # single test
```

`cargo check` is always the right first step — it catches type errors in seconds without producing a binary.

## Tests

Integration tests live in `backend/tests/` and use [`axum-test`](https://crates.io/crates/axum-test) to exercise the router against an in-process server.

- [`tests/common/mod.rs`](tests/common/mod.rs) builds the `AppConfig` directly (rather than going through `AppConfig::from_env`), so the stricter startup validation does not affect test fixtures. Tests can use any secret length without exporting env vars.
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

Produces `target/release/stream-backend`. The [`release` profile in Cargo.toml](Cargo.toml) enables LTO + strip, giving roughly a 9 MB statically-linked binary when built against musl via the Dockerfile.

The production image uses a multi-stage build:

```
rust:1-alpine (builder, musl target)  →  alpine:3.20 + ca-certificates (runtime)
```

The resulting image is ~15 MB total.

## Where things live

| Path | Contents |
|---|---|
| [`src/main.rs`](src/main.rs) | Startup: bcrypt-hash admin password, init DB pool, spawn background tasks, mount router, `axum::serve` |
| [`src/config.rs`](src/config.rs) | `AppConfig::from_env` — fail-fast validation of secrets |
| [`src/state.rs`](src/state.rs) | `AppState` — shared `Arc` for DB pool, config, event channels, HTTP client |
| [`src/db.rs`](src/db.rs) | `r2d2_sqlite` pool + schema bootstrap from `schema.sql` |
| [`src/routes/`](src/routes/) | HTTP handlers, one file per resource |
| [`src/ws.rs`](src/ws.rs) | `/ws/room/:slug` hub — chat, presence, pointer, kick events |
| [`src/livekit.rs`](src/livekit.rs) | Hand-rolled LiveKit client (AccessToken + RoomService calls over reqwest) |
| [`src/tasks.rs`](src/tasks.rs) | Background pollers (OME state, room expiry, file cleanup) |
| [`schema.sql`](schema.sql) | Source of truth for the SQLite schema |

For architectural context, security notes, and the list of project-specific pitfalls, see [../Streaming.md](../Streaming.md).
