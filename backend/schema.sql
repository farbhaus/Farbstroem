CREATE TABLE IF NOT EXISTS rooms (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    slug          TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    presenter_key TEXT,
    delivery_mode TEXT NOT NULL DEFAULT 'webrtc',
    waiting_room  INTEGER NOT NULL DEFAULT 0,
    expires_at    DATETIME,
    status        TEXT NOT NULL DEFAULT 'pending',
    stream_key_id TEXT REFERENCES stream_keys(id) ON DELETE SET NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at    DATETIME,
    ended_at      DATETIME
);

CREATE TABLE IF NOT EXISTS stream_keys (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    key_token   TEXT UNIQUE NOT NULL,
    room_id     TEXT REFERENCES rooms(id) ON DELETE SET NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS participants (
    id          TEXT PRIMARY KEY,
    room_id     TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'viewer',
    is_admitted INTEGER NOT NULL DEFAULT 0,
    is_kicked   INTEGER NOT NULL DEFAULT 0,
    token       TEXT UNIQUE,
    joined_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS session_files (
    id            TEXT PRIMARY KEY,
    room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    uploader_id   TEXT REFERENCES participants(id) ON DELETE SET NULL,
    original_name TEXT NOT NULL,
    stored_path   TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id         TEXT PRIMARY KEY,
    room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    role       TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rooms_slug          ON rooms(slug);
CREATE INDEX IF NOT EXISTS idx_rooms_status        ON rooms(status);
CREATE INDEX IF NOT EXISTS idx_rooms_stream_key    ON rooms(stream_key_id);
CREATE INDEX IF NOT EXISTS idx_stream_keys_token   ON stream_keys(key_token);
CREATE INDEX IF NOT EXISTS idx_stream_keys_room    ON stream_keys(room_id);
CREATE INDEX IF NOT EXISTS idx_participants_room   ON participants(room_id);
CREATE INDEX IF NOT EXISTS idx_participants_token  ON participants(token);
CREATE INDEX IF NOT EXISTS idx_chat_messages_room  ON chat_messages(room_id, created_at);
