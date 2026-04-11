use axum::{
    extract::{Path, Query, State},
    response::sse::{Event, Sse},
    routing::{get, post},
    Json, Router,
};
use rand::RngExt;
use serde::Deserialize;
use base64::Engine;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::sync::Arc;
use tokio_stream::StreamExt;

use crate::error::AppError;
use crate::events::KickedEvent;
use crate::livekit::LiveKitClient;
use crate::state::AppState;

use tracing::info;

fn row_to_json(row: &rusqlite::Row, columns: &[&str]) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    for (i, col) in columns.iter().enumerate() {
        let val: rusqlite::types::Value = row.get_unwrap(i);
        map.insert(
            col.to_string(),
            match val {
                rusqlite::types::Value::Null => Value::Null,
                rusqlite::types::Value::Integer(n) => json!(n),
                rusqlite::types::Value::Real(f) => json!(f),
                rusqlite::types::Value::Text(s) => json!(s),
                rusqlite::types::Value::Blob(b) => {
                    json!(base64::engine::general_purpose::STANDARD.encode(b))
                }
            },
        );
    }
    Value::Object(map)
}

// GET /:slug/info - safe room info (no auth)
async fn room_info(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<Json<Value>, AppError> {
    let conn = state.db.get()?;
    let room = tokio::task::spawn_blocking(move || {
        let mut stmt = conn.prepare(
            "SELECT id, name, slug, delivery_mode, waiting_room, \
             CASE WHEN password_hash IS NOT NULL AND password_hash != '' THEN 1 ELSE 0 END as has_password, \
             status \
             FROM rooms WHERE slug = ?1",
        )?;
        let cols = &[
            "id",
            "name",
            "slug",
            "delivery_mode",
            "waiting_room",
            "has_password",
            "status",
        ];
        let row = stmt
            .query_row(rusqlite::params![slug], |row| Ok(row_to_json(row, cols)))
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    AppError::NotFound("Room not found".into())
                }
                _ => AppError::Internal(e.to_string()),
            })?;
        Ok::<_, AppError>(row)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;

    Ok(Json(room))
}

#[derive(Deserialize)]
struct JoinBody {
    name: Option<String>,
    password: Option<String>,
    role: Option<String>,
    presenter_key: Option<String>,
}

// POST /:slug/join - join a room (public)
async fn join_room(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Json(body): Json<JoinBody>,
) -> Result<Json<Value>, AppError> {
    let name = body
        .name
        .ok_or_else(|| AppError::BadRequest("Name is required".into()))?;

    let conn = state.db.get()?;
    let slug_clone = slug.clone();
    let room_data = tokio::task::spawn_blocking(move || {
        let mut stmt = conn.prepare(
            "SELECT r.id, r.name, r.slug, r.password_hash, r.presenter_key, \
             r.delivery_mode, r.waiting_room, r.status, r.expires_at, \
             sk.key_token \
             FROM rooms r \
             LEFT JOIN stream_keys sk ON sk.id = r.stream_key_id \
             WHERE r.slug = ?1",
        )?;
        let result = stmt
            .query_row(rusqlite::params![slug_clone], |row| {
                Ok((
                    row.get::<_, String>(0)?,        // id
                    row.get::<_, String>(1)?,         // name
                    row.get::<_, String>(2)?,         // slug
                    row.get::<_, Option<String>>(3)?, // password_hash
                    row.get::<_, Option<String>>(4)?, // presenter_key
                    row.get::<_, String>(5)?,         // delivery_mode
                    row.get::<_, i32>(6)?,            // waiting_room
                    row.get::<_, String>(7)?,         // status
                    row.get::<_, Option<String>>(8)?, // expires_at
                    row.get::<_, Option<String>>(9)?, // stream key_token
                ))
            })
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    AppError::NotFound("Room not found".into())
                }
                _ => AppError::Internal(e.to_string()),
            })?;
        Ok::<_, AppError>(result)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;

    let (
        room_id,
        room_name,
        _room_slug,
        password_hash,
        presenter_key,
        delivery_mode,
        waiting_room,
        status,
        expires_at,
        stream_key,
    ) = room_data;

    // 410 if ended
    if status == "ended" {
        return Err(AppError::Gone("Room has ended".into()));
    }

    // 410 if expired
    if let Some(ref exp) = expires_at {
        // Simple string comparison works for ISO datetime format
        let now = chrono_now();
        if exp < &now {
            return Err(AppError::Gone("Room has expired".into()));
        }
    }

    // 401 if password required but wrong
    if let Some(ref hash) = password_hash {
        if !hash.is_empty() {
            let provided = body.password.clone().unwrap_or_default();
            if provided.is_empty() {
                return Err(AppError::Unauthorized("Password required".into()));
            }
            let hash_clone = hash.clone();
            let valid = tokio::task::spawn_blocking(move || bcrypt::verify(provided, &hash_clone))
                .await
                .map_err(|e| AppError::Internal(e.to_string()))?
                .map_err(|_| AppError::Unauthorized("Wrong password".into()))?;
            if !valid {
                return Err(AppError::Unauthorized("Wrong password".into()));
            }
        }
    }

    // Check if name is kicked (case-insensitive)
    let conn = state.db.get()?;
    let room_id_clone = room_id.clone();
    let name_clone = name.clone();
    let is_kicked = tokio::task::spawn_blocking(move || {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM participants \
             WHERE room_id = ?1 AND LOWER(name) = LOWER(?2) AND is_kicked = 1",
            rusqlite::params![room_id_clone, name_clone],
            |row| row.get(0),
        )?;
        Ok::<_, rusqlite::Error>(count > 0)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;

    if is_kicked {
        return Err(AppError::Forbidden(
            "You have been kicked from this room".into(),
        ));
    }

    // Determine role
    let requested_role = body.role.as_deref().unwrap_or("viewer");
    let role = if requested_role == "presenter" {
        if let Some(ref pk) = presenter_key {
            if body.presenter_key.as_deref() == Some(pk.as_str()) {
                "presenter"
            } else {
                "viewer"
            }
        } else {
            "viewer"
        }
    } else {
        "viewer"
    };

    // Auto-admit if no waiting room or if presenter
    let is_admitted: i32 = if waiting_room == 0 || role == "presenter" {
        1
    } else {
        0
    };

    let participant_id = uuid::Uuid::new_v4().to_string();
    let token_bytes: [u8; 24] = rand::rng().random();
    let token: String = token_bytes.iter().map(|b| format!("{:02x}", b)).collect();

    let conn = state.db.get()?;
    let pid = participant_id.clone();
    let rid = room_id.clone();
    let tok = token.clone();
    let p_name = name.clone();
    let p_role = role.to_string();
    tokio::task::spawn_blocking(move || {
        conn.execute(
            "INSERT INTO participants (id, room_id, name, role, is_admitted, token) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![pid, rid, p_name, p_role, is_admitted, tok],
        )?;
        Ok::<_, rusqlite::Error>(())
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;

    Ok(Json(json!({
        "participant_id": participant_id,
        "token": token,
        "role": role,
        "admitted": is_admitted == 1,
        "delivery_mode": delivery_mode,
        "waiting_room": waiting_room != 0,
        "stream_key": stream_key,
        "room_name": room_name,
        "status": status,
    })))
}

#[derive(Deserialize)]
struct StatusQuery {
    token: Option<String>,
}

// GET /:slug/status/:participantId?token= - admission poll
async fn participant_status(
    State(state): State<Arc<AppState>>,
    Path((slug, participant_id)): Path<(String, String)>,
    Query(query): Query<StatusQuery>,
) -> Result<Json<Value>, AppError> {
    let token = query
        .token
        .ok_or_else(|| AppError::Unauthorized("Token required".into()))?;

    let conn = state.db.get()?;
    let result = tokio::task::spawn_blocking(move || {
        let mut stmt = conn.prepare(
            "SELECT p.is_admitted, p.is_kicked, r.status \
             FROM participants p \
             JOIN rooms r ON r.id = p.room_id \
             WHERE p.id = ?1 AND p.token = ?2 AND r.slug = ?3",
        )?;
        let result = stmt
            .query_row(
                rusqlite::params![participant_id, token, slug],
                |row| {
                    Ok((
                        row.get::<_, i32>(0)?,
                        row.get::<_, i32>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    AppError::NotFound("Participant not found".into())
                }
                _ => AppError::Internal(e.to_string()),
            })?;
        Ok::<_, AppError>(result)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;

    let (is_admitted, _is_kicked, _room_status) = result;

    Ok(Json(json!({
        "admitted": is_admitted == 1,
    })))
}

#[derive(Deserialize)]
struct WaitingEventsQuery {
    token: Option<String>,
}

// GET /:slug/waiting/events/:participantId?token= - SSE for waiting room
async fn waiting_events(
    State(state): State<Arc<AppState>>,
    Path((slug, participant_id)): Path<(String, String)>,
    Query(query): Query<WaitingEventsQuery>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, AppError> {
    let token = query
        .token
        .ok_or_else(|| AppError::Unauthorized("Token required".into()))?;

    // Validate token first
    let conn = state.db.get()?;
    let pid = participant_id.clone();
    let tok = token.clone();
    let s = slug.clone();
    tokio::task::spawn_blocking(move || {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM participants p \
             JOIN rooms r ON r.id = p.room_id \
             WHERE p.id = ?1 AND p.token = ?2 AND r.slug = ?3",
            rusqlite::params![pid, tok, s],
            |row| row.get(0),
        )?;
        if count == 0 {
            return Err(AppError::NotFound("Participant not found".into()));
        }
        Ok::<_, AppError>(())
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;

    let stream = tokio_stream::wrappers::IntervalStream::new(tokio::time::interval(
        std::time::Duration::from_secs(2),
    ))
    .map(move |_| {
        let state = state.clone();
        let participant_id = participant_id.clone();
        let slug = slug.clone();
        (state, participant_id, slug)
    })
    .then(|(state, participant_id, slug)| async move {
        let conn = match state.db.get() {
            Ok(c) => c,
            Err(_) => {
                return Ok(Event::default().event("ping").data("{}"));
            }
        };
        let result = tokio::task::spawn_blocking(move || {
            let mut stmt = conn.prepare(
                "SELECT p.is_admitted, p.is_kicked, r.status \
                 FROM participants p \
                 JOIN rooms r ON r.id = p.room_id \
                 WHERE p.id = ?1 AND r.slug = ?2",
            )?;
            let result = stmt.query_row(
                rusqlite::params![participant_id, slug],
                |row| {
                    Ok((
                        row.get::<_, i32>(0)?,
                        row.get::<_, i32>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )?;
            Ok::<_, rusqlite::Error>(result)
        })
        .await;

        match result {
            Ok(Ok((is_admitted, _is_kicked, _room_status))) => {
                if is_admitted == 1 {
                    Ok(Event::default()
                        .event("admitted")
                        .data(json!({}).to_string()))
                } else {
                    Ok(Event::default()
                        .event("ping")
                        .data(json!({}).to_string()))
                }
            }
            // Participant not found (kicked/deleted) - send ping; client will handle
            _ => Ok(Event::default()
                .event("ping")
                .data(json!({}).to_string())),
        }
    });

    Ok(Sse::new(stream))
}

#[derive(Deserialize)]
struct LivekitTokenQuery {
    #[serde(rename = "participantId")]
    participant_id: Option<String>,
    token: Option<String>,
}

// GET /:slug/livekit-token?participantId=&token= - get LiveKit access token
async fn livekit_token(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Query(query): Query<LivekitTokenQuery>,
) -> Result<Json<Value>, AppError> {
    let participant_id = query
        .participant_id
        .ok_or_else(|| AppError::BadRequest("participantId required".into()))?;
    let token = query
        .token
        .ok_or_else(|| AppError::Unauthorized("Token required".into()))?;

    let conn = state.db.get()?;
    let slug_clone = slug.clone();
    let pid = participant_id.clone();
    let participant_data = tokio::task::spawn_blocking(move || {
        let mut stmt = conn.prepare(
            "SELECT p.name, p.role, p.is_admitted, p.is_kicked, r.slug \
             FROM participants p \
             JOIN rooms r ON r.id = p.room_id \
             WHERE p.id = ?1 AND p.token = ?2 AND r.slug = ?3",
        )?;
        let result = stmt
            .query_row(rusqlite::params![pid, token, slug_clone], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i32>(2)?,
                    row.get::<_, i32>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    AppError::NotFound("Participant not found".into())
                }
                _ => AppError::Internal(e.to_string()),
            })?;
        Ok::<_, AppError>(result)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;

    let (name, role, is_admitted, is_kicked, room_slug) = participant_data;

    if is_kicked == 1 {
        return Err(AppError::Forbidden("You have been kicked".into()));
    }
    if is_admitted == 0 {
        return Err(AppError::Forbidden("Not yet admitted".into()));
    }

    let livekit = LiveKitClient::new(&state.config, state.http_client.clone());
    let lk_token = livekit
        .create_access_token(&participant_id, &name, &room_slug, &role)
        .map_err(|e| AppError::Internal(e))?;

    Ok(Json(json!({ "token": lk_token, "url": state.config.livekit_url })))
}

#[derive(Deserialize)]
struct KickBody {
    #[serde(rename = "participantId")]
    participant_id: Option<String>,
    token: Option<String>,
    #[serde(rename = "targetId")]
    target_id: Option<String>,
}

// POST /:slug/conference/kick - kick a participant (presenter action)
async fn kick_participant(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Json(body): Json<KickBody>,
) -> Result<Json<Value>, AppError> {
    let participant_id = body
        .participant_id
        .ok_or_else(|| AppError::BadRequest("participantId required".into()))?;
    let token = body
        .token
        .ok_or_else(|| AppError::Unauthorized("Token required".into()))?;
    let target_id = body
        .target_id
        .ok_or_else(|| AppError::BadRequest("targetId required".into()))?;

    // Validate requester is presenter
    let conn = state.db.get()?;
    let slug_clone = slug.clone();
    let pid = participant_id.clone();
    let role = tokio::task::spawn_blocking(move || {
        let role: String = conn
            .query_row(
                "SELECT p.role FROM participants p \
                 JOIN rooms r ON r.id = p.room_id \
                 WHERE p.id = ?1 AND p.token = ?2 AND r.slug = ?3",
                rusqlite::params![pid, token, slug_clone],
                |row| row.get(0),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    AppError::NotFound("Participant not found".into())
                }
                _ => AppError::Internal(e.to_string()),
            })?;
        Ok::<_, AppError>(role)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;

    if role != "presenter" {
        return Err(AppError::Forbidden("Only presenters can kick".into()));
    }

    // Mark target as kicked
    let conn = state.db.get()?;
    let tid = target_id.clone();
    let slug_clone = slug.clone();
    tokio::task::spawn_blocking(move || {
        let changes = conn.execute(
            "UPDATE participants SET is_kicked = 1 \
             WHERE id = ?1 AND room_id = (SELECT id FROM rooms WHERE slug = ?2)",
            rusqlite::params![tid, slug_clone],
        )?;
        if changes == 0 {
            return Err(AppError::NotFound("Target participant not found".into()));
        }
        Ok::<_, AppError>(())
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;

    info!(
        room_slug = %slug,
        actor_id = %participant_id,
        target_id = %target_id,
        action = "kick",
        "participant kicked",
    );

    let _ = state.events.participant_kicked.send(KickedEvent {
        slug: slug.clone(),
        participant_id: target_id.clone(),
    });

    // Try to remove from LiveKit
    let livekit = LiveKitClient::new(&state.config, state.http_client.clone());
    let _ = livekit.remove_participant(&slug, &target_id).await;

    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct MuteBody {
    #[serde(rename = "participantId")]
    participant_id: Option<String>,
    token: Option<String>,
    #[serde(rename = "targetId")]
    target_id: Option<String>,
    #[serde(rename = "trackSid")]
    track_sid: Option<String>,
    muted: Option<bool>,
}

// POST /:slug/conference/mute - mute a participant's track (presenter action)
async fn mute_participant(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Json(body): Json<MuteBody>,
) -> Result<Json<Value>, AppError> {
    let participant_id = body
        .participant_id
        .ok_or_else(|| AppError::BadRequest("participantId required".into()))?;
    let token = body
        .token
        .ok_or_else(|| AppError::Unauthorized("Token required".into()))?;
    let target_id = body
        .target_id
        .ok_or_else(|| AppError::BadRequest("targetId required".into()))?;
    let track_sid = body
        .track_sid
        .ok_or_else(|| AppError::BadRequest("trackSid required".into()))?;
    let muted = body.muted.unwrap_or(true);

    // Validate requester is presenter
    let conn = state.db.get()?;
    let slug_clone = slug.clone();
    let pid = participant_id.clone();
    let role = tokio::task::spawn_blocking(move || {
        let role: String = conn
            .query_row(
                "SELECT p.role FROM participants p \
                 JOIN rooms r ON r.id = p.room_id \
                 WHERE p.id = ?1 AND p.token = ?2 AND r.slug = ?3",
                rusqlite::params![pid, token, slug_clone],
                |row| row.get(0),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    AppError::NotFound("Participant not found".into())
                }
                _ => AppError::Internal(e.to_string()),
            })?;
        Ok::<_, AppError>(role)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;

    if role != "presenter" {
        return Err(AppError::Forbidden("Only presenters can mute".into()));
    }

    let livekit = LiveKitClient::new(&state.config, state.http_client.clone());
    livekit
        .mute_published_track(&slug, &target_id, &track_sid, muted)
        .await
        .map_err(|e| AppError::Internal(e))?;

    info!(
        room_slug = %slug,
        actor_id = %participant_id,
        target_id = %target_id,
        track_sid = %track_sid,
        muted,
        action = "mute",
        "participant track muted",
    );

    Ok(Json(json!({ "ok": true })))
}

/// Get current time as an ISO-ish string for comparison with SQLite DATETIME values.
fn chrono_now() -> String {
    // SQLite CURRENT_TIMESTAMP format: "YYYY-MM-DD HH:MM:SS"
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    // Convert to broken-down time manually (UTC)
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Days since epoch to Y-M-D (simplified algorithm)
    let mut y = 1970i64;
    let mut remaining_days = days as i64;

    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if remaining_days < days_in_year {
            break;
        }
        remaining_days -= days_in_year;
        y += 1;
    }

    let month_days = if is_leap(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };

    let mut m = 0usize;
    for (i, &md) in month_days.iter().enumerate() {
        if remaining_days < md {
            m = i;
            break;
        }
        remaining_days -= md;
    }

    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        y,
        m + 1,
        remaining_days + 1,
        hours,
        minutes,
        seconds
    )
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/{slug}/info", get(room_info))
        .route("/{slug}/join", post(join_room))
        .route(
            "/{slug}/status/{participantId}",
            get(participant_status),
        )
        .route(
            "/{slug}/waiting/events/{participantId}",
            get(waiting_events),
        )
        .route("/{slug}/livekit-token", get(livekit_token))
        .route("/{slug}/conference/kick", post(kick_participant))
        .route("/{slug}/conference/mute", post(mute_participant))
}
