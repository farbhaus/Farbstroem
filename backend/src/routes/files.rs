use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::{header, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

use tracing::info;

use crate::error::AppError;
use crate::events::FileSharedEvent;
use crate::state::AppState;

const MAX_FILE_SIZE: usize = 100 * 1024 * 1024; // 100MB

pub const SAFE_MIMES: &[&str] = &[
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/avif",
    // image/svg+xml is intentionally NOT here: SVGs served inline execute any
    // embedded <script> in the browser's document context, which would be a
    // stored-XSS vector against the admin previewing a participant upload.
    // `nosniff` doesn't help — the content-type really is image/svg+xml.
    // SVGs fall through to application/octet-stream + attachment disposition.
    "video/mp4",
    "video/quicktime",
    "video/x-quicktime",
    "video/webm",
    "audio/mpeg",
    "audio/wav",
    "audio/ogg",
    "audio/flac",
    "application/pdf",
    "text/plain",
    "application/zip",
    "application/x-zip-compressed",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

#[derive(Deserialize)]
struct ParticipantQuery {
    #[serde(rename = "participantId")]
    participant_id: Option<String>,
    token: Option<String>,
}

#[derive(Deserialize)]
struct UploadQuery {
    #[serde(rename = "participantId")]
    participant_id: Option<String>,
    token: Option<String>,
    /// When true, the file is stored as a draft (is_shared=0) — no
    /// `file:shared` WS event, no room_files mirror — until the
    /// participant explicitly shares it via the WS `file:share` message.
    #[serde(default)]
    defer: bool,
}

struct ParticipantInfo {
    id: String,
    name: String,
    role: String,
    room_id: String,
    slug: String,
}

fn validate_participant(
    conn: &r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>,
    pid: &str,
    token: &str,
    slug: &str,
) -> Result<ParticipantInfo, AppError> {
    let row = conn
        .query_row(
            "SELECT p.id, p.name, p.role, r.id AS room_id, r.slug \
             FROM participants p \
             JOIN rooms r ON r.id = p.room_id \
             WHERE p.id = ?1 AND p.token = ?2 AND r.slug = ?3 \
             AND p.is_admitted = 1 AND p.is_kicked = 0",
            params![pid, token, slug],
            |row| {
                Ok(ParticipantInfo {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    role: row.get(2)?,
                    room_id: row.get(3)?,
                    slug: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|e| AppError::Internal(e.to_string()))?
        .ok_or_else(|| AppError::Unauthorized("Unauthorized".into()))?;
    Ok(row)
}

pub fn sanitize_mime(mime: &str) -> String {
    if SAFE_MIMES.contains(&mime) {
        mime.to_string()
    } else {
        "application/octet-stream".to_string()
    }
}

/// Derive a `.ext` suffix (including leading dot) from a filename, or "" if
/// the filename has no usable extension. Used for the stored blob filename so
/// downloads can hint at the type.
///
/// The result is concatenated straight into an on-disk path, so it MUST stay
/// path-safe: ASCII alphanumeric only, 1-10 chars, no `/`, `\`, or `.`.
/// Anything else is dropped — a crafted filename like `x.../../../../tmp/p`
/// would otherwise escape the files dir and let an uploader write anywhere
/// the backend user can.
pub fn extract_extension(name: &str) -> String {
    let ext = match name.rsplit('.').next() {
        Some(e) if e != name => e,
        _ => return String::new(),
    };
    if ext.is_empty() || ext.len() > 10 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return String::new();
    }
    format!(".{}", ext)
}

async fn upload_file(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Query(query): Query<UploadQuery>,
    mut multipart: Multipart,
) -> Result<Json<Value>, AppError> {
    let defer = query.defer;
    let pid = query
        .participant_id
        .as_deref()
        .ok_or(AppError::Unauthorized("Unauthorized".into()))?
        .to_string();
    let token = query
        .token
        .as_deref()
        .ok_or(AppError::Unauthorized("Unauthorized".into()))?
        .to_string();

    // Validate participant
    let conn = state.db.get()?;
    let slug_clone = slug.clone();
    let pid_clone = pid.clone();
    let token_clone = token.clone();
    let participant = tokio::task::spawn_blocking(move || {
        validate_participant(&conn, &pid_clone, &token_clone, &slug_clone)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?
    {
        if field.name() == Some("file") {
            let original_name = field.file_name().unwrap_or("upload").to_string();
            let mime_raw = field
                .content_type()
                .unwrap_or("application/octet-stream")
                .to_string();
            let mime = sanitize_mime(&mime_raw);
            let data = field
                .bytes()
                .await
                .map_err(|e| AppError::BadRequest(e.to_string()))?;

            if data.len() > MAX_FILE_SIZE {
                return Err(AppError::BadRequest("File too large (max 100MB)".into()));
            }

            let size = data.len() as u64;

            // Content-addressable hash for dedup
            let mut hasher = Sha256::new();
            hasher.update(&data);
            let content_hash = format!("{:x}", hasher.finalize());

            let files_dir = format!("{}/files", state.config.data_path);
            tokio::fs::create_dir_all(&files_dir)
                .await
                .map_err(|e| AppError::Internal(e.to_string()))?;

            // Dedup applies only to non-deferred uploads. Drafts always get
            // a fresh row (and content_hash = NULL) so we don't entangle
            // them with already-shared files; the file:share handler later
            // re-computes the hash for dedup against future uploads.
            let existing: Option<String> = if defer {
                None
            } else {
                let conn = state.db.get()?;
                let hash_lookup = content_hash.clone();
                tokio::task::spawn_blocking(move || {
                    conn.query_row(
                        "SELECT id FROM session_files WHERE content_hash = ?1 LIMIT 1",
                        params![hash_lookup],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(|e| AppError::Internal(e.to_string()))
                })
                .await
                .map_err(|e| AppError::Internal(e.to_string()))??
            };

            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();

            let (file_id, effective_name) = if let Some(id) = existing {
                info!(
                    room_slug = %participant.slug,
                    actor_id = %participant.id,
                    file_id = %id,
                    action = "upload_dedup",
                    "participant upload hit existing blob",
                );
                (id, original_name.clone())
            } else {
                let new_id = uuid::Uuid::new_v4().to_string();
                let ext = extract_extension(&original_name);
                let stored_name = format!("{}{}", new_id, ext);

                tokio::fs::write(format!("{}/{}", files_dir, stored_name), &data)
                    .await
                    .map_err(|e| AppError::Internal(e.to_string()))?;

                let conn = state.db.get()?;
                let new_id_clone = new_id.clone();
                let original_name_clone = original_name.clone();
                let stored_name_clone = stored_name.clone();
                let mime_clone = mime.clone();
                let room_id = participant.room_id.clone();
                let pid_db = participant.id.clone();
                // Drafts skip the hash so they don't trip the UNIQUE index
                // against shared rows of the same content.
                let hash_clone: Option<String> = if defer {
                    None
                } else {
                    Some(content_hash.clone())
                };
                let is_shared_val: i64 = if defer { 0 } else { 1 };
                tokio::task::spawn_blocking(move || {
                    conn.execute(
                        "INSERT INTO session_files (id, room_id, uploader_id, original_name, stored_path, mime_type, size_bytes, content_hash, is_shared, created_at) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime(?10, 'unixepoch'))",
                        params![
                            new_id_clone,
                            room_id,
                            pid_db,
                            original_name_clone,
                            stored_name_clone,
                            mime_clone,
                            size as i64,
                            hash_clone,
                            is_shared_val,
                            ts as i64,
                        ],
                    )
                })
                .await
                .map_err(|e| AppError::Internal(e.to_string()))??;

                (new_id, original_name.clone())
            };

            // For drafts: skip the library mirror and the live broadcast.
            // Both run later when the participant fires the file:share WS
            // message (see ws.rs handler).
            if !defer {
                // Best-effort mirror into room_files so the admin library
                // surfaces the same file with its room chip.
                let conn = state.db.get()?;
                let file_id_mirror = file_id.clone();
                let room_id_mirror = participant.room_id.clone();
                let mirror_res = tokio::task::spawn_blocking(move || {
                    conn.execute(
                        "INSERT OR IGNORE INTO room_files (room_id, file_id) VALUES (?1, ?2)",
                        params![room_id_mirror, file_id_mirror],
                    )
                })
                .await;
                if let Ok(Err(e)) = mirror_res {
                    tracing::warn!("room_files mirror failed for {}: {}", file_id, e);
                }

                let _ = state.events.file_shared.send(FileSharedEvent {
                    slug: participant.slug.clone(),
                    id: file_id.clone(),
                    participant_id: participant.id.clone(),
                    uploader_name: participant.name.clone(),
                    role: participant.role.clone(),
                    name: effective_name.clone(),
                    size,
                    mime: mime.clone(),
                    ts,
                });
            }

            info!(
                room_slug = %participant.slug,
                actor_id = %participant.id,
                file_id = %file_id,
                size,
                action = if defer { "upload_complete_deferred" } else { "upload_complete" },
                "file upload complete",
            );

            return Ok(Json(json!({
                "id": file_id,
                "name": effective_name,
                "size": size,
            })));
        }
    }

    Err(AppError::BadRequest("No file".into()))
}

async fn list_files(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Query(query): Query<ParticipantQuery>,
) -> Result<Json<Vec<Value>>, AppError> {
    let pid = query
        .participant_id
        .as_deref()
        .ok_or(AppError::Unauthorized("Unauthorized".into()))?
        .to_string();
    let token = query
        .token
        .as_deref()
        .ok_or(AppError::Unauthorized("Unauthorized".into()))?
        .to_string();

    let conn = state.db.get()?;
    let slug_clone = slug.clone();
    let files = tokio::task::spawn_blocking(move || {
        let participant = validate_participant(&conn, &pid, &token, &slug_clone)?;

        // Union of (a) files whose room_id matches this room (legacy path)
        // and (b) files linked via room_files (library + mirrored participant
        // uploads). DISTINCT because both sources overlap after migration.
        // Drafts (is_shared = 0) stay invisible until the uploader hits send.
        let mut stmt = conn.prepare(
            "SELECT DISTINCT sf.id, sf.original_name, sf.mime_type, sf.size_bytes, sf.created_at, \
             p.name AS uploader_name, p.role AS uploader_role \
             FROM session_files sf \
             LEFT JOIN participants p ON p.id = sf.uploader_id \
             WHERE sf.is_shared = 1 \
               AND (sf.room_id = ?1 \
                    OR sf.id IN (SELECT file_id FROM room_files WHERE room_id = ?1)) \
             ORDER BY sf.created_at ASC",
        )?;
        let rows = stmt
            .query_map(params![participant.room_id], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "name": row.get::<_, String>(1)?,
                    "mime": row.get::<_, String>(2)?,
                    "size": row.get::<_, i64>(3)?,
                    "createdAt": row.get::<_, String>(4)?,
                    "uploaderName": row.get::<_, Option<String>>(5)?.unwrap_or_else(|| "Admin".into()),
                    "uploaderRole": row.get::<_, Option<String>>(6)?.unwrap_or_else(|| "admin".into()),
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok::<_, AppError>(rows)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;

    Ok(Json(files))
}

async fn download_file(
    State(state): State<Arc<AppState>>,
    Path((slug, file_id)): Path<(String, String)>,
    Query(query): Query<ParticipantQuery>,
) -> Result<impl IntoResponse, AppError> {
    let pid = query
        .participant_id
        .as_deref()
        .ok_or(AppError::Unauthorized("Unauthorized".into()))?
        .to_string();
    let token = query
        .token
        .as_deref()
        .ok_or(AppError::Unauthorized("Unauthorized".into()))?
        .to_string();

    let conn = state.db.get()?;
    let data_path = state.config.data_path.clone();
    let (file_data, original_name, mime) = tokio::task::spawn_blocking(move || {
        let participant = validate_participant(&conn, &pid, &token, &slug)?;

        // Authorised if the file is directly attached to the room OR assigned
        // to it via room_files (admin library).
        let (stored_name, original_name, mime): (String, String, String) = conn
            .query_row(
                "SELECT stored_path, original_name, mime_type FROM session_files \
                 WHERE id = ?1 AND (room_id = ?2 \
                    OR id IN (SELECT file_id FROM room_files WHERE room_id = ?2))",
                params![file_id, participant.room_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|e| AppError::Internal(e.to_string()))?
            .ok_or_else(|| AppError::NotFound("File not found".into()))?;

        let file_path = format!("{}/files/{}", data_path, stored_name);
        Ok::<_, AppError>((file_path, original_name, mime))
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;

    let data = tokio::fs::read(&file_data)
        .await
        .map_err(|_| AppError::NotFound("File not found".into()))?;

    let disposition = format!(
        "attachment; filename=\"{}\"",
        original_name.replace('"', "\\\"")
    );

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, mime),
            (header::CONTENT_DISPOSITION, disposition),
            (
                header::HeaderName::from_static("x-content-type-options"),
                "nosniff".to_string(),
            ),
        ],
        data,
    ))
}

/// Delete a draft (unshared) upload. Used when a participant removes the
/// chip from their chat composer before sending. Only the original
/// uploader can delete, and only while the file is still a draft —
/// shared files are part of chat history and stay around.
async fn delete_draft_file(
    State(state): State<Arc<AppState>>,
    Path((slug, file_id)): Path<(String, String)>,
    Query(query): Query<ParticipantQuery>,
) -> Result<StatusCode, AppError> {
    let pid = query
        .participant_id
        .as_deref()
        .ok_or(AppError::Unauthorized("Unauthorized".into()))?
        .to_string();
    let token = query
        .token
        .as_deref()
        .ok_or(AppError::Unauthorized("Unauthorized".into()))?
        .to_string();

    let conn = state.db.get()?;
    let data_path = state.config.data_path.clone();
    let stored = tokio::task::spawn_blocking(move || -> Result<Option<String>, AppError> {
        let participant = validate_participant(&conn, &pid, &token, &slug)?;
        // Lookup + ownership + draft check in one shot.
        let stored_path: Option<String> = conn
            .query_row(
                "SELECT stored_path FROM session_files \
                 WHERE id = ?1 AND uploader_id = ?2 AND is_shared = 0",
                params![file_id, participant.id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| AppError::Internal(e.to_string()))?;
        let stored_path = match stored_path {
            Some(p) => p,
            None => return Ok(None),
        };
        conn.execute("DELETE FROM session_files WHERE id = ?1", params![file_id])
            .map_err(|e| AppError::Internal(e.to_string()))?;
        Ok(Some(stored_path))
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;

    if let Some(stored_name) = stored {
        let blob_path = format!("{}/files/{}", data_path, stored_name);
        let _ = tokio::fs::remove_file(&blob_path).await;
    }
    // Idempotent: missing/already-shared returns 204 too, since either way
    // the client's intent ("draft is gone") holds.
    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/{slug}/files", post(upload_file).get(list_files))
        .route("/{slug}/files/{fileId}/download", get(download_file))
        .route(
            "/{slug}/files/{fileId}",
            axum::routing::delete(delete_draft_file),
        )
        .layer(DefaultBodyLimit::max(MAX_FILE_SIZE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_extension_normal_cases() {
        assert_eq!(extract_extension("photo.jpg"), ".jpg");
        assert_eq!(extract_extension("doc.pdf"), ".pdf");
        assert_eq!(extract_extension("archive.tar.gz"), ".gz");
        assert_eq!(extract_extension("noext"), "");
        assert_eq!(extract_extension(""), "");
        // Dotfile: the whole basename after the dot is treated as the ext.
        // Path-safe so we keep it.
        assert_eq!(extract_extension(".hidden"), ".hidden");
    }

    #[test]
    fn extract_extension_rejects_path_traversal() {
        // The dangerous cases: anything that would let the on-disk write
        // escape the files dir or smuggle a separator.
        assert_eq!(extract_extension("evil.../../../../tmp/p"), "");
        assert_eq!(extract_extension("x.tar/../etc/passwd"), "");
        assert_eq!(extract_extension("y.a/b"), "");
        assert_eq!(extract_extension("z.a\\b"), "");
        assert_eq!(extract_extension("w..ext"), ".ext"); // single trailing ext OK
    }

    #[test]
    fn extract_extension_caps_length_and_charset() {
        // 10 alnum chars OK, 11 rejected.
        assert_eq!(extract_extension("a.abcdefghij"), ".abcdefghij");
        assert_eq!(extract_extension("a.abcdefghijk"), "");
        // Non-alnum (unicode, punctuation) rejected.
        assert_eq!(extract_extension("a.exé"), "");
        assert_eq!(extract_extension("a.ex!"), "");
    }

    #[test]
    fn sanitize_mime_drops_svg() {
        // Regression for the stored-XSS preview path: SVG must not survive
        // sanitize_mime, so admin preview falls through to octet-stream
        // and gets attachment disposition.
        assert_eq!(sanitize_mime("image/svg+xml"), "application/octet-stream");
        assert_eq!(sanitize_mime("image/png"), "image/png");
        assert_eq!(sanitize_mime("text/html"), "application/octet-stream");
    }
}
