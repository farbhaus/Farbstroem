use base64::Engine;
use std::sync::Arc;
use std::time::Duration;
use tokio::time;
use crate::state::AppState;
use crate::livekit::LiveKitClient;

// ---------------------------------------------------------------------------
// OME Poller -- every 30s
// Checks active streams against OME API; resets rooms to 'pending' if their
// stream key is no longer broadcasting.
// ---------------------------------------------------------------------------

pub fn spawn_ome_poller(state: Arc<AppState>) {
    tokio::spawn(async move {
        let mut interval = time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            if let Err(e) = poll_ome(&state).await {
                tracing::debug!("[poller] OME poll error: {}", e);
            }
        }
    });
}

async fn poll_ome(state: &Arc<AppState>) -> Result<(), Box<dyn std::error::Error>> {
    let token = base64::engine::general_purpose::STANDARD
        .encode(&state.config.ome_api_token);
    let url = format!(
        "{}/vhosts/default/apps/live/streams",
        state.config.ome_api_url
    );

    let res = state
        .http_client
        .get(&url)
        .header("Authorization", format!("Basic {}", token))
        .send()
        .await?;

    if !res.status().is_success() {
        return Ok(());
    }

    let data: serde_json::Value = res.json().await?;
    let active_keys: std::collections::HashSet<String> = data
        .get("response")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let db = state.db.get()?;
    let mut stmt = db.prepare(
        "SELECT r.id, r.slug, sk.key_token \
         FROM rooms r \
         JOIN stream_keys sk ON sk.id = r.stream_key_id \
         WHERE r.status = 'live'",
    )?;
    let live_rooms: Vec<(String, String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .filter_map(|r| r.ok())
        .collect();

    for (id, slug, key_token) in live_rooms {
        if !active_keys.contains(&key_token) {
            db.execute(
                "UPDATE rooms SET status = 'pending' WHERE id = ?1",
                rusqlite::params![id],
            )?;
            let _ = state.events.room_pending.send(slug.clone());
            tracing::info!("[poller] Room {} -> pending (stream dropped)", id);
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Expiry Poller -- every 60s
// Ends rooms that have passed their expires_at timestamp.
// ---------------------------------------------------------------------------

pub fn spawn_expiry_poller(state: Arc<AppState>) {
    tokio::spawn(async move {
        let mut interval = time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            if let Err(e) = poll_expiry(&state).await {
                tracing::debug!("[poller] Expiry poll error: {}", e);
            }
        }
    });
}

pub async fn poll_expiry(state: &Arc<AppState>) -> Result<(), Box<dyn std::error::Error>> {
    let expired_rooms: Vec<(String, String)> = {
        let db = state.db.get()?;
        let mut stmt = db.prepare(
            "SELECT id, slug FROM rooms \
             WHERE expires_at IS NOT NULL \
             AND expires_at < CURRENT_TIMESTAMP \
             AND status != 'ended'",
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.filter_map(|r| r.ok()).collect()
    };

    if expired_rooms.is_empty() {
        return Ok(());
    }

    let livekit = LiveKitClient::new(&state.config, state.http_client.clone());

    for (id, slug) in expired_rooms {
        let db = state.db.get()?;
        db.execute(
            "UPDATE rooms SET status = 'ended', ended_at = CURRENT_TIMESTAMP WHERE id = ?1",
            rusqlite::params![id],
        )?;

        let _ = state.events.room_ended.send(slug.clone());
        tracing::info!("[poller] Room {} expired -> ended", id);

        // Delete LiveKit room (best-effort)
        if let Err(e) = livekit.delete_room(&slug).await {
            tracing::debug!("[poller] LiveKit deleteRoom error for {}: {}", slug, e);
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Room-Ended File Cleanup -- immediate cleanup when a room ends
// ---------------------------------------------------------------------------

pub fn spawn_room_ended_cleanup(state: Arc<AppState>) {
    let mut rx = state.events.room_ended.subscribe();
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(slug) => {
                    if let Err(e) = cleanup_room_files(&state, &slug).await {
                        tracing::debug!("[files] Room ended cleanup error for {}: {}", slug, e);
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::debug!("[files] Room ended cleanup lagged by {} events", n);
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

pub async fn cleanup_room_files(
    state: &Arc<AppState>,
    slug: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let db = state.db.get()?;
    let slug_owned = slug.to_string();
    let data_path = state.config.data_path.clone();

    let files: Vec<(String, String, String)> = tokio::task::spawn_blocking(move || {
        let room_id: Option<String> = db
            .query_row(
                "SELECT id FROM rooms WHERE slug = ?1",
                rusqlite::params![slug_owned],
                |row| row.get(0),
            )
            .ok();

        let room_id = match room_id {
            Some(id) => id,
            None => return Ok(Vec::new()),
        };

        let mut stmt = db.prepare(
            "SELECT id, stored_path, room_id FROM session_files WHERE room_id = ?1",
        )?;
        let rows: Vec<(String, String, String)> = stmt
            .query_map(rusqlite::params![room_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .filter_map(|r| r.ok())
            .collect();

        // Delete DB rows
        db.execute(
            "DELETE FROM session_files WHERE room_id = ?1",
            rusqlite::params![room_id],
        )?;

        Ok::<_, rusqlite::Error>(rows)
    })
    .await
    .map_err(|e| -> Box<dyn std::error::Error> { Box::new(e) })??;

    if files.is_empty() {
        return Ok(());
    }

    let mut room_id_for_dir = String::new();
    for (file_id, stored_path, room_id) in &files {
        room_id_for_dir = room_id.clone();
        let full_path = format!("{}/uploads/{}/{}", data_path, room_id, stored_path);
        match tokio::fs::remove_file(&full_path).await {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                tracing::debug!("[files] Failed to delete {}: {}", full_path, e);
            }
        }
        let _ = file_id; // used in DB delete above
    }

    // Try to remove the empty room upload directory
    if !room_id_for_dir.is_empty() {
        let dir_path = format!("{}/uploads/{}", data_path, room_id_for_dir);
        let _ = tokio::fs::remove_dir(&dir_path).await;
    }

    tracing::info!("[files] Cleaned up files for room (ended)");
    Ok(())
}

// ---------------------------------------------------------------------------
// Weekly File Cleanup -- 60s initial delay, then every 7 days
// Removes files from disk for ended/expired rooms.
// ---------------------------------------------------------------------------

pub fn spawn_weekly_cleanup(state: Arc<AppState>) {
    tokio::spawn(async move {
        // Initial delay before first run
        time::sleep(Duration::from_secs(60)).await;

        let interval_duration = Duration::from_secs(7 * 24 * 60 * 60); // 7 days
        let mut interval = time::interval(interval_duration);

        loop {
            interval.tick().await;
            if let Err(e) = cleanup_files(&state).await {
                tracing::debug!("[cleanup] Weekly file cleanup error: {}", e);
            }
        }
    });
}

async fn cleanup_files(state: &Arc<AppState>) -> Result<(), Box<dyn std::error::Error>> {
    let files_to_delete: Vec<(String, String, String)> = {
        let db = state.db.get()?;
        let mut stmt = db.prepare(
            "SELECT sf.id, sf.stored_path, sf.room_id \
             FROM session_files sf \
             JOIN rooms r ON r.id = sf.room_id \
             WHERE r.status = 'ended' \
             OR (r.expires_at IS NOT NULL AND r.expires_at < CURRENT_TIMESTAMP)",
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        rows.filter_map(|r| r.ok()).collect()
    };

    if files_to_delete.is_empty() {
        tracing::info!("[cleanup] No files to clean up");
        return Ok(());
    }

    tracing::info!("[cleanup] Cleaning up {} files", files_to_delete.len());

    let mut deleted_count = 0u64;

    for (file_id, stored_path, room_id) in &files_to_delete {
        // Delete file from disk
        let full_path = format!("{}/uploads/{}/{}", state.config.data_path, room_id, stored_path);
        match tokio::fs::remove_file(&full_path).await {
            Ok(_) => {
                deleted_count += 1;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // Already gone, still delete DB row
            }
            Err(e) => {
                tracing::debug!("[cleanup] Failed to delete {}: {}", full_path, e);
            }
        }

        // Delete DB row
        let db = state.db.get()?;
        db.execute(
            "DELETE FROM session_files WHERE id = ?1",
            rusqlite::params![file_id],
        )?;

        // Try to remove parent directory if empty
        if let Some(parent) = std::path::Path::new(&full_path).parent() {
            let _ = tokio::fs::remove_dir(parent).await; // only succeeds if empty
        }
    }

    tracing::info!(
        "[cleanup] Deleted {} files from disk, {} DB rows removed",
        deleted_count,
        files_to_delete.len()
    );

    Ok(())
}
