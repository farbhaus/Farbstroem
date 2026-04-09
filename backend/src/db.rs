use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use std::fs;

pub type DbPool = Pool<SqliteConnectionManager>;

pub fn init_pool(db_path: &str) -> DbPool {
    let manager = SqliteConnectionManager::file(db_path);
    let pool = Pool::builder()
        .max_size(8)
        .build(manager)
        .expect("Failed to create database pool");

    let conn = pool.get().expect("Failed to get connection");
    conn.execute_batch("PRAGMA journal_mode = WAL;").unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    conn.execute_batch("PRAGMA synchronous = NORMAL;").unwrap();

    // Apply schema
    let schema = fs::read_to_string("schema.sql")
        .or_else(|_| fs::read_to_string("/app/schema.sql"))
        .expect("Failed to read schema.sql");
    conn.execute_batch(&schema).unwrap();

    // Migrations for existing databases
    let has_stream_key_id: bool = conn
        .prepare("PRAGMA table_info(rooms)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .any(|name| name.as_deref() == Ok("stream_key_id"));

    if !has_stream_key_id {
        conn.execute_batch(
            "ALTER TABLE rooms ADD COLUMN stream_key_id TEXT REFERENCES stream_keys(id) ON DELETE SET NULL;
             UPDATE rooms SET stream_key_id = (SELECT id FROM stream_keys WHERE stream_keys.room_id = rooms.id LIMIT 1);
             CREATE INDEX IF NOT EXISTS idx_rooms_stream_key ON rooms(stream_key_id);"
        ).unwrap();
    }

    let has_is_kicked: bool = conn
        .prepare("PRAGMA table_info(participants)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .any(|name| name.as_deref() == Ok("is_kicked"));

    if !has_is_kicked {
        conn.execute_batch("ALTER TABLE participants ADD COLUMN is_kicked INTEGER NOT NULL DEFAULT 0").unwrap();
    }

    let has_presenter_key: bool = conn
        .prepare("PRAGMA table_info(rooms)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .any(|name| name.as_deref() == Ok("presenter_key"));

    if !has_presenter_key {
        conn.execute_batch(
            "ALTER TABLE rooms ADD COLUMN presenter_key TEXT;
             UPDATE rooms SET presenter_key = lower(hex(randomblob(16))) WHERE presenter_key IS NULL;"
        ).unwrap();
    }

    pool
}
