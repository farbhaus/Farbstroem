mod common;

use std::fs;

// ---------------------------------------------------------------------------
// Helper: seed a room with a specific expires_at value
// ---------------------------------------------------------------------------

fn seed_room_with_expiry(
    state: &std::sync::Arc<stream_backend::state::AppState>,
    name: &str,
    slug: &str,
    status: &str,
    expires_at: &str,
) -> String {
    let conn = state.db.get().unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let presenter_key: String = (0..16)
        .map(|_| format!("{:02x}", rand::random::<u8>()))
        .collect();
    conn.execute(
        "INSERT INTO rooms (id, name, slug, presenter_key, delivery_mode, waiting_room, status, expires_at) \
         VALUES (?1, ?2, ?3, ?4, 'webrtc', 0, ?5, ?6)",
        rusqlite::params![id, name, slug, presenter_key, status, expires_at],
    )
    .unwrap();
    id
}

fn seed_file(
    state: &std::sync::Arc<stream_backend::state::AppState>,
    room_id: &str,
    file_name: &str,
    data_path: &str,
) -> String {
    let conn = state.db.get().unwrap();
    let file_id = uuid::Uuid::new_v4().to_string();
    let stored_name = format!("{}.bin", file_id);

    conn.execute(
        "INSERT INTO session_files (id, room_id, original_name, stored_path, mime_type, size_bytes) \
         VALUES (?1, ?2, ?3, ?4, 'application/octet-stream', 100)",
        rusqlite::params![file_id, room_id, file_name, stored_name],
    )
    .unwrap();

    // Create actual file on disk (flat layout)
    let dir = format!("{}/files", data_path);
    fs::create_dir_all(&dir).unwrap();
    let path = format!("{}/{}", dir, stored_name);
    fs::write(&path, b"test file content").unwrap();

    file_id
}

fn get_room_status(
    state: &std::sync::Arc<stream_backend::state::AppState>,
    room_id: &str,
) -> (String, Option<String>) {
    let conn = state.db.get().unwrap();
    conn.query_row(
        "SELECT status, ended_at FROM rooms WHERE id = ?1",
        rusqlite::params![room_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .unwrap()
}

fn count_files(state: &std::sync::Arc<stream_backend::state::AppState>, room_id: &str) -> i64 {
    let conn = state.db.get().unwrap();
    conn.query_row(
        "SELECT COUNT(*) FROM session_files WHERE room_id = ?1",
        rusqlite::params![room_id],
        |row| row.get(0),
    )
    .unwrap()
}

// ---------------------------------------------------------------------------
// poll_expiry: expired room transitions to 'ended'
// ---------------------------------------------------------------------------

#[tokio::test]
async fn poll_expiry_ends_expired_room() {
    let state = common::test_state();
    // expires_at in the past
    let room_id = seed_room_with_expiry(
        &state,
        "Expiry Test",
        "expiry-test",
        "live",
        "2020-01-01 00:00:00",
    );

    stream_backend::tasks::poll_expiry(&state).await.unwrap();

    let (status, ended_at) = get_room_status(&state, &room_id);
    assert_eq!(status, "ended");
    assert!(ended_at.is_some(), "ended_at should be set");
}

// ---------------------------------------------------------------------------
// poll_expiry: room with future expires_at is not touched
// ---------------------------------------------------------------------------

#[tokio::test]
async fn poll_expiry_ignores_future_room() {
    let state = common::test_state();
    let room_id = seed_room_with_expiry(
        &state,
        "Future Room",
        "future-room",
        "live",
        "2099-12-31 23:59:59",
    );

    stream_backend::tasks::poll_expiry(&state).await.unwrap();

    let (status, ended_at) = get_room_status(&state, &room_id);
    assert_eq!(status, "live");
    assert!(ended_at.is_none());
}

// ---------------------------------------------------------------------------
// poll_expiry: already-ended rooms are not processed again
// ---------------------------------------------------------------------------

#[tokio::test]
async fn poll_expiry_skips_already_ended() {
    let state = common::test_state();
    let room_id = seed_room_with_expiry(
        &state,
        "Ended Room",
        "ended-room",
        "ended",
        "2020-01-01 00:00:00",
    );

    // Should not error or re-process
    stream_backend::tasks::poll_expiry(&state).await.unwrap();

    let (status, _) = get_room_status(&state, &room_id);
    assert_eq!(status, "ended");
}

// ---------------------------------------------------------------------------
// poll_expiry: pending expired room also gets ended
// ---------------------------------------------------------------------------

#[tokio::test]
async fn poll_expiry_ends_pending_expired_room() {
    let state = common::test_state();
    let room_id = seed_room_with_expiry(
        &state,
        "Pending Expired",
        "pending-expired",
        "pending",
        "2020-06-15 12:00:00",
    );

    stream_backend::tasks::poll_expiry(&state).await.unwrap();

    let (status, ended_at) = get_room_status(&state, &room_id);
    assert_eq!(status, "ended");
    assert!(ended_at.is_some());
}

// ---------------------------------------------------------------------------
// poll_expiry: room without expires_at is not touched
// ---------------------------------------------------------------------------

#[tokio::test]
async fn poll_expiry_ignores_room_without_expiry() {
    let state = common::test_state();
    let room_id = common::seed_room(&state, "No Expiry", "no-expiry");

    stream_backend::tasks::poll_expiry(&state).await.unwrap();

    let (status, ended_at) = get_room_status(&state, &room_id);
    assert_eq!(status, "pending");
    assert!(ended_at.is_none());
}

// ---------------------------------------------------------------------------
// poll_expiry: emits room_ended event
// ---------------------------------------------------------------------------

#[tokio::test]
async fn poll_expiry_emits_room_ended_event() {
    let state = common::test_state();
    let mut rx = state.events.room_ended.subscribe();

    seed_room_with_expiry(
        &state,
        "Event Room",
        "event-room",
        "live",
        "2020-01-01 00:00:00",
    );

    stream_backend::tasks::poll_expiry(&state).await.unwrap();

    let slug = rx.try_recv().unwrap();
    assert_eq!(slug, "event-room");
}

// ---------------------------------------------------------------------------
// cleanup_room_files: removes files from DB and disk
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cleanup_room_files_removes_files() {
    let state = common::test_state();
    let data_path = state.config.data_path.clone();
    let room_id = seed_room_with_expiry(
        &state,
        "File Cleanup",
        "file-cleanup",
        "live",
        "2020-01-01 00:00:00",
    );

    let file_id = seed_file(&state, &room_id, "test.txt", &data_path);

    // Verify file exists on disk (flat layout)
    let stored_name = format!("{}.bin", file_id);
    let file_path = format!("{}/files/{}", data_path, stored_name);
    assert!(std::path::Path::new(&file_path).exists());
    assert_eq!(count_files(&state, &room_id), 1);

    // Run cleanup
    stream_backend::tasks::cleanup_room_files(&state, "file-cleanup")
        .await
        .unwrap();

    // DB rows removed
    assert_eq!(count_files(&state, &room_id), 0);

    // File removed from disk
    assert!(!std::path::Path::new(&file_path).exists());
}

// ---------------------------------------------------------------------------
// cleanup_room_files: no-op for room without files
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cleanup_room_files_noop_without_files() {
    let state = common::test_state();
    seed_room_with_expiry(
        &state,
        "No Files",
        "no-files",
        "live",
        "2020-01-01 00:00:00",
    );

    // Should not error
    stream_backend::tasks::cleanup_room_files(&state, "no-files")
        .await
        .unwrap();
}

// ---------------------------------------------------------------------------
// End-to-end: expiry + cleanup full lifecycle
// ---------------------------------------------------------------------------

#[tokio::test]
async fn full_expiry_lifecycle() {
    let state = common::test_state();
    let data_path = state.config.data_path.clone();
    let mut rx = state.events.room_ended.subscribe();

    // Create room with past expiry and a file
    let room_id = seed_room_with_expiry(
        &state,
        "Full Lifecycle",
        "full-lifecycle",
        "live",
        "2020-01-01 00:00:00",
    );
    let file_id = seed_file(&state, &room_id, "video.mp4", &data_path);

    let stored_name = format!("{}.bin", file_id);
    let file_path = format!("{}/files/{}", data_path, stored_name);

    // Step 1: poll_expiry transitions room to ended
    stream_backend::tasks::poll_expiry(&state).await.unwrap();

    let (status, ended_at) = get_room_status(&state, &room_id);
    assert_eq!(status, "ended", "room should be ended");
    assert!(ended_at.is_some(), "ended_at should be set");

    // Step 2: room_ended event was emitted
    let slug = rx.try_recv().unwrap();
    assert_eq!(slug, "full-lifecycle");

    // Step 3: cleanup removes files
    stream_backend::tasks::cleanup_room_files(&state, "full-lifecycle")
        .await
        .unwrap();

    assert_eq!(
        count_files(&state, &room_id),
        0,
        "files should be removed from DB"
    );
    assert!(
        !std::path::Path::new(&file_path).exists(),
        "file should be removed from disk"
    );
}
