use axum::{
    extract::{
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use tokio::sync::{mpsc, RwLock};
use tracing::{error, info};

use rusqlite::OptionalExtension;

use crate::events::FileSharedEvent;
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

pub type WsRooms = Arc<RwLock<HashMap<String, HashMap<String, WsParticipant>>>>;

pub struct WsParticipant {
    pub id: String,
    pub name: String,
    pub role: String,
    pub tx: mpsc::UnboundedSender<Message>,
    pub disconnect_timer: Option<tokio::task::JoinHandle<()>>,
}

static WS_ROOMS: LazyLock<WsRooms> = LazyLock::new(|| Arc::new(RwLock::new(HashMap::new())));

// Current host-pinned focus per room. Held in memory only — late joiners
// receive the current value on auth, but a server restart resets it.
// Value is the tile id ("stream" | "share") or absence = unpinned.
type WsRoomFocus = Arc<RwLock<HashMap<String, String>>>;
static WS_ROOM_FOCUS: LazyLock<WsRoomFocus> =
    LazyLock::new(|| Arc::new(RwLock::new(HashMap::new())));

// ---------------------------------------------------------------------------
// Auth message
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct AuthMsg {
    #[serde(rename = "type")]
    msg_type: String,
    #[serde(rename = "participantId")]
    participant_id: String,
    token: String,
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/ws/room/{slug}", get(ws_handler))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(slug): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, slug, state))
}

// ---------------------------------------------------------------------------
// Socket handler
// ---------------------------------------------------------------------------

async fn handle_socket(socket: WebSocket, slug: String, state: Arc<AppState>) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    // Spawn send task: forward from mpsc channel to websocket sink
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Wait for auth message (first message)
    let auth = match wait_for_auth(&mut stream).await {
        Some(a) => a,
        None => {
            let _ = tx.send(Message::Close(Some(CloseFrame {
                code: 1008,
                reason: "Auth required".into(),
            })));
            send_task.abort();
            return;
        }
    };

    if auth.msg_type != "auth" {
        let _ = tx.send(Message::Close(Some(CloseFrame {
            code: 1008,
            reason: "First message must be auth".into(),
        })));
        send_task.abort();
        return;
    }

    // Validate participant against DB
    let participant_id = auth.participant_id.clone();
    let token = auth.token.clone();

    let db_result = {
        let conn = match state.db.get() {
            Ok(c) => c,
            Err(e) => {
                error!("DB pool error during WS auth: {}", e);
                let _ = tx.send(Message::Close(Some(CloseFrame {
                    code: 1011,
                    reason: "Internal error".into(),
                })));
                send_task.abort();
                return;
            }
        };

        conn.query_row(
            "SELECT p.id, p.name, p.role, p.is_admitted, p.is_kicked, r.slug
             FROM participants p
             JOIN rooms r ON r.id = p.room_id
             WHERE p.id = ?1 AND p.token = ?2 AND r.slug = ?3",
            rusqlite::params![participant_id, token, slug],
            |row| {
                Ok((
                    row.get::<_, String>(0)?, // id
                    row.get::<_, String>(1)?, // name
                    row.get::<_, String>(2)?, // role
                    row.get::<_, bool>(3)?,   // is_admitted
                    row.get::<_, bool>(4)?,   // is_kicked
                ))
            },
        )
    };

    let (pid, name, role, is_admitted, is_kicked) = match db_result {
        Ok(row) => row,
        Err(_) => {
            let _ = tx.send(Message::Text(
                json!({"type": "error", "message": "Invalid credentials"})
                    .to_string()
                    .into(),
            ));
            let _ = tx.send(Message::Close(Some(CloseFrame {
                code: 1008,
                reason: "Auth failed".into(),
            })));
            send_task.abort();
            return;
        }
    };

    if is_kicked {
        let _ = tx.send(Message::Text(json!({"type": "kicked"}).to_string().into()));
        let _ = tx.send(Message::Close(Some(CloseFrame {
            code: 1008,
            reason: "Kicked".into(),
        })));
        send_task.abort();
        return;
    }

    if !is_admitted {
        let _ = tx.send(Message::Text(
            json!({"type": "error", "message": "Not admitted"})
                .to_string()
                .into(),
        ));
        let _ = tx.send(Message::Close(Some(CloseFrame {
            code: 1008,
            reason: "Not admitted".into(),
        })));
        send_task.abort();
        return;
    }

    // Auth success - register participant
    {
        let mut rooms = WS_ROOMS.write().await;
        let room = rooms.entry(slug.clone()).or_default();

        if let Some(existing) = room.get_mut(&pid) {
            // Reconnection: cancel disconnect timer and replace sender
            if let Some(timer) = existing.disconnect_timer.take() {
                timer.abort();
            }
            existing.tx = tx.clone();
        } else {
            room.insert(
                pid.clone(),
                WsParticipant {
                    id: pid.clone(),
                    name: name.clone(),
                    role: role.clone(),
                    tx: tx.clone(),
                    disconnect_timer: None,
                },
            );
        }
    }

    // Send auth:ok
    let _ = tx.send(Message::Text(json!({"type": "auth:ok"}).to_string().into()));

    // Replay current host-pinned focus so a late joiner lands in the same
    // view as everyone else.
    {
        let focus = WS_ROOM_FOCUS.read().await;
        if let Some(tile_id) = focus.get(&slug) {
            let _ = tx.send(Message::Text(
                json!({"type": "focus:set", "tileId": tile_id})
                    .to_string()
                    .into(),
            ));
        }
    }

    // Send chat history (last 50)
    send_chat_history(&state, &slug, &tx);

    // Broadcast participants update
    broadcast_participants(&WS_ROOMS, &slug).await;

    info!("WS connected: participant={} slug={}", pid, slug);

    // Message loop
    let slug_clone = slug.clone();
    let pid_clone = pid.clone();
    let name_clone = name.clone();
    let role_clone = role.clone();

    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(text) => {
                handle_text_message(
                    &state,
                    &slug_clone,
                    &pid_clone,
                    &name_clone,
                    &role_clone,
                    &text,
                )
                .await;
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // Disconnect: start grace period
    info!("WS disconnected: participant={} slug={}", pid, slug);
    start_disconnect_timer(&WS_ROOMS, slug, pid).await;

    send_task.abort();
}

// ---------------------------------------------------------------------------
// Auth waiting
// ---------------------------------------------------------------------------

async fn wait_for_auth(stream: &mut futures::stream::SplitStream<WebSocket>) -> Option<AuthMsg> {
    // Wait up to 10 seconds for auth message
    let timeout = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while let Some(Ok(msg)) = stream.next().await {
            if let Message::Text(text) = msg {
                return serde_json::from_str::<AuthMsg>(&text).ok();
            }
        }
        None
    });

    timeout.await.unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

async fn handle_text_message(
    state: &Arc<AppState>,
    slug: &str,
    participant_id: &str,
    name: &str,
    role: &str,
    text: &str,
) {
    let msg: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };

    let msg_type = match msg.get("type").and_then(|t| t.as_str()) {
        Some(t) => t,
        None => return,
    };

    match msg_type {
        "chat:message" => {
            let chat_text = match msg.get("text").and_then(|t| t.as_str()) {
                Some(t) => t,
                None => return,
            };

            let trimmed: String = chat_text.chars().take(500).collect();
            if trimmed.trim().is_empty() {
                return;
            }

            let msg_id = uuid::Uuid::new_v4().to_string();
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;

            // Persist to DB
            if let Ok(conn) = state.db.get() {
                let _ = conn.execute(
                    "INSERT INTO chat_messages (id, room_id, name, role, text)
                     VALUES (?1, (SELECT id FROM rooms WHERE slug = ?2), ?3, ?4, ?5)",
                    rusqlite::params![msg_id, slug, name, role, trimmed],
                );
            }

            let broadcast_msg = json!({
                "type": "chat:message",
                "id": msg_id,
                "participantId": participant_id,
                "name": name,
                "role": role,
                "text": trimmed,
                "ts": ts,
            });

            broadcast_to_room(&WS_ROOMS, slug, &broadcast_msg.to_string()).await;
        }
        "pointer:move" => {
            let x = msg.get("x").and_then(|v| v.as_f64());
            let y = msg.get("y").and_then(|v| v.as_f64());

            match (x, y) {
                (Some(x), Some(y)) if x.is_finite() && y.is_finite() => {
                    let broadcast_msg = json!({
                        "type": "pointer:move",
                        "participantId": participant_id,
                        "name": name,
                        "x": x,
                        "y": y,
                    });
                    broadcast_to_room(&WS_ROOMS, slug, &broadcast_msg.to_string()).await;
                }
                _ => {}
            }
        }
        "pointer:hide" => {
            let broadcast_msg = json!({
                "type": "pointer:hide",
                "participantId": participant_id,
            });
            broadcast_to_room(&WS_ROOMS, slug, &broadcast_msg.to_string()).await;
        }
        "file:share" => {
            let file_id = match msg.get("fileId").and_then(|t| t.as_str()) {
                Some(s) if !s.is_empty() => s.to_string(),
                _ => return,
            };

            let conn = match state.db.get() {
                Ok(c) => c,
                Err(_) => return,
            };
            let pid_for_block = participant_id.to_string();
            let slug_for_block = slug.to_string();
            let file_id_lookup = file_id.clone();
            // Pull the draft file row and validate ownership + room match.
            // Returns (stored_room_id, original_name, mime_type, size_bytes,
            // is_shared_was) on success.
            type DraftRow = (String, String, String, i64, i64);
            let row: Option<DraftRow> = match tokio::task::spawn_blocking(move || {
                conn.query_row(
                    "SELECT sf.room_id, sf.original_name, sf.mime_type, sf.size_bytes, sf.is_shared \
                     FROM session_files sf \
                     JOIN rooms r ON r.id = sf.room_id \
                     WHERE sf.id = ?1 AND sf.uploader_id = ?2 AND r.slug = ?3",
                    rusqlite::params![file_id_lookup, pid_for_block, slug_for_block],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, i64>(4)?,
                        ))
                    },
                )
                .optional()
                .unwrap_or(None)
            })
            .await
            {
                Ok(opt) => opt,
                Err(_) => return,
            };

            let (room_id, original_name, mime, size_bytes, is_shared_was) = match row {
                Some(t) => t,
                None => return,
            };

            // Already shared? Treat as a no-op — the file is already in chat
            // history. Sending a chat message alongside is unaffected.
            if is_shared_was != 0 {
                return;
            }

            // Flip the draft to shared + mirror into the admin library.
            let conn = match state.db.get() {
                Ok(c) => c,
                Err(_) => return,
            };
            let file_id_db = file_id.clone();
            let room_id_db = room_id.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let _ = conn.execute(
                    "UPDATE session_files SET is_shared = 1 WHERE id = ?1",
                    rusqlite::params![file_id_db],
                );
                let _ = conn.execute(
                    "INSERT OR IGNORE INTO room_files (room_id, file_id) VALUES (?1, ?2)",
                    rusqlite::params![room_id_db, file_id_db],
                );
            })
            .await;

            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();

            let _ = state.events.file_shared.send(FileSharedEvent {
                slug: slug.to_string(),
                id: file_id,
                participant_id: participant_id.to_string(),
                uploader_name: name.to_string(),
                role: role.to_string(),
                name: original_name,
                size: size_bytes as u64,
                mime,
                ts,
            });
        }
        "focus:set" => {
            // Only presenters can drive the host pin. Viewers' clicks are
            // local-only and never reach the server.
            if role != "presenter" {
                return;
            }
            // tileId may be a string ("stream"/"share") or null (unpin).
            let tile_id = msg.get("tileId");
            let valid_tile = match tile_id {
                Some(Value::String(s)) if s == "stream" || s == "share" => Some(s.clone()),
                Some(Value::Null) | None => None,
                _ => return, // unknown tile id — ignore
            };
            {
                let mut focus = WS_ROOM_FOCUS.write().await;
                if let Some(t) = &valid_tile {
                    focus.insert(slug.to_string(), t.clone());
                } else {
                    focus.remove(slug);
                }
            }
            let broadcast_msg = json!({
                "type": "focus:set",
                "tileId": valid_tile,
            });
            broadcast_to_room(&WS_ROOMS, slug, &broadcast_msg.to_string()).await;
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Chat history
// ---------------------------------------------------------------------------

fn send_chat_history(state: &Arc<AppState>, slug: &str, tx: &mpsc::UnboundedSender<Message>) {
    let conn = match state.db.get() {
        Ok(c) => c,
        Err(_) => return,
    };

    // Interleave chat messages and file uploads by timestamp so files
    // appear in their original chat-sequence position on rejoin.
    let mut stmt = match conn.prepare(
        "SELECT kind, id, name, role, text, file_name, size_bytes, mime_type, ts \
         FROM ( \
             SELECT 'chat' AS kind, cm.id, cm.name, cm.role, cm.text, \
                    NULL AS file_name, NULL AS size_bytes, NULL AS mime_type, \
                    cm.created_at AS ts \
             FROM chat_messages cm \
             JOIN rooms r ON r.id = cm.room_id \
             WHERE r.slug = ?1 \
             UNION ALL \
             SELECT 'file' AS kind, sf.id, p.name, p.role, NULL AS text, \
                    sf.original_name AS file_name, sf.size_bytes, sf.mime_type, \
                    sf.created_at AS ts \
             FROM session_files sf \
             JOIN rooms r ON r.id = sf.room_id \
             LEFT JOIN participants p ON p.id = sf.uploader_id \
             WHERE r.slug = ?1 AND sf.is_shared = 1 \
         ) combined \
         ORDER BY ts DESC \
         LIMIT 50",
    ) {
        Ok(s) => s,
        Err(_) => return,
    };

    let messages: Vec<Value> = stmt
        .query_map(rusqlite::params![slug], |row| {
            let kind: String = row.get(0)?;
            if kind == "file" {
                Ok(json!({
                    "type": "file:shared",
                    "id": row.get::<_, String>(1)?,
                    "uploaderName": row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    "role": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    "name": row.get::<_, String>(5)?,
                    "size": row.get::<_, i64>(6)?,
                    "mime": row.get::<_, String>(7)?,
                    "ts": row.get::<_, String>(8)?,
                }))
            } else {
                Ok(json!({
                    "id": row.get::<_, String>(1)?,
                    "name": row.get::<_, String>(2)?,
                    "role": row.get::<_, String>(3)?,
                    "text": row.get::<_, String>(4)?,
                    "ts": row.get::<_, String>(8)?,
                }))
            }
        })
        .ok()
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default();

    // Reverse to send oldest first
    let mut messages = messages;
    messages.reverse();

    let history_msg = json!({
        "type": "chat:history",
        "messages": messages,
    });

    let _ = tx.send(Message::Text(history_msg.to_string().into()));
}

// ---------------------------------------------------------------------------
// Disconnect timer
// ---------------------------------------------------------------------------

async fn start_disconnect_timer(rooms: &WsRooms, slug: String, participant_id: String) {
    let rooms = rooms.clone();
    let slug_clone = slug.clone();
    let pid_clone = participant_id.clone();

    let timer = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

        let mut rooms_guard = rooms.write().await;
        let mut room_empty = false;

        if let Some(room) = rooms_guard.get_mut(&slug_clone) {
            room.remove(&pid_clone);
            room_empty = room.is_empty();
        }

        if room_empty {
            rooms_guard.remove(&slug_clone);
        }

        drop(rooms_guard);

        if !room_empty {
            broadcast_participants(&rooms, &slug_clone).await;
        }
    });

    // Store the timer handle on the participant (if still in the map)
    let mut rooms_guard = WS_ROOMS.write().await;
    if let Some(room) = rooms_guard.get_mut(&slug) {
        if let Some(p) = room.get_mut(&participant_id) {
            p.disconnect_timer = Some(timer);
        }
    }
}

// ---------------------------------------------------------------------------
// Broadcasting helpers
// ---------------------------------------------------------------------------

async fn broadcast_to_room(rooms: &WsRooms, slug: &str, msg: &str) {
    let rooms_guard = rooms.read().await;
    if let Some(room) = rooms_guard.get(slug) {
        for participant in room.values() {
            let _ = participant.tx.send(Message::Text(msg.to_string().into()));
        }
    }
}

async fn broadcast_participants(rooms: &WsRooms, slug: &str) {
    let rooms_guard = rooms.read().await;
    if let Some(room) = rooms_guard.get(slug) {
        let participants: Vec<Value> = room
            .values()
            .map(|p| {
                json!({
                    "id": p.id,
                    "name": p.name,
                    "role": p.role,
                })
            })
            .collect();

        let msg = json!({
            "type": "participants:update",
            "participants": participants,
        })
        .to_string();

        for participant in room.values() {
            let _ = participant.tx.send(Message::Text(msg.clone().into()));
        }
    }
}

/// Send a message to a specific participant and close their connection.
async fn send_to_participant_and_close(
    rooms: &WsRooms,
    slug: &str,
    participant_id: &str,
    msg: &str,
) {
    let mut rooms_guard = rooms.write().await;
    if let Some(room) = rooms_guard.get_mut(slug) {
        if let Some(participant) = room.remove(participant_id) {
            let _ = participant.tx.send(Message::Text(msg.to_string().into()));
            let _ = participant.tx.send(Message::Close(Some(CloseFrame {
                code: 1008,
                reason: "Kicked".into(),
            })));
            if let Some(timer) = participant.disconnect_timer {
                timer.abort();
            }
        }

        if room.is_empty() {
            let slug_owned = slug.to_string();
            rooms_guard.remove(&slug_owned);
        }
    }
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

pub fn spawn_event_listeners(state: Arc<AppState>) {
    // room:live
    {
        let mut rx = state.events.room_live.subscribe();
        tokio::spawn(async move {
            while let Ok(slug) = rx.recv().await {
                let msg = json!({"type": "room:live"}).to_string();
                broadcast_to_room(&WS_ROOMS, &slug, &msg).await;
            }
        });
    }

    // room:pending
    {
        let mut rx = state.events.room_pending.subscribe();
        tokio::spawn(async move {
            while let Ok(slug) = rx.recv().await {
                let msg = json!({"type": "room:pending"}).to_string();
                broadcast_to_room(&WS_ROOMS, &slug, &msg).await;
            }
        });
    }

    // room:ended
    {
        let state = state.clone();
        let mut rx = state.events.room_ended.subscribe();
        tokio::spawn(async move {
            while let Ok(slug) = rx.recv().await {
                let msg = json!({"type": "room:ended"}).to_string();

                // Send ended message + Close frame to every participant, then remove room
                {
                    let mut rooms = WS_ROOMS.write().await;
                    if let Some(room) = rooms.remove(&slug) {
                        for (_pid, participant) in room {
                            let _ = participant.tx.send(Message::Text(msg.clone().into()));
                            let _ = participant.tx.send(Message::Close(Some(CloseFrame {
                                code: 1001,
                                reason: "Room ended".into(),
                            })));
                            if let Some(timer) = participant.disconnect_timer {
                                timer.abort();
                            }
                        }
                    }
                }

                // Delete LiveKit room (best-effort, may already be done by caller)
                let livekit =
                    crate::livekit::LiveKitClient::new(&state.config, state.http_client.clone());
                let _ = livekit.delete_room(&slug).await;

                // Delete chat messages for this room
                if let Ok(conn) = state.db.get() {
                    let _ = conn.execute(
                        "DELETE FROM chat_messages WHERE room_id = (SELECT id FROM rooms WHERE slug = ?1)",
                        rusqlite::params![slug],
                    );
                }
            }
        });
    }

    // stream:assigned
    {
        let mut rx = state.events.stream_key_assigned.subscribe();
        tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                let msg = json!({
                    "type": "stream:assigned",
                    "streamKey": event.stream_key,
                })
                .to_string();
                broadcast_to_room(&WS_ROOMS, &event.slug, &msg).await;
            }
        });
    }

    // stream:removed
    {
        let mut rx = state.events.stream_key_removed.subscribe();
        tokio::spawn(async move {
            while let Ok(slug) = rx.recv().await {
                let msg = json!({"type": "stream:removed"}).to_string();
                broadcast_to_room(&WS_ROOMS, &slug, &msg).await;
            }
        });
    }

    // file:shared
    {
        let mut rx = state.events.file_shared.subscribe();
        tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                let msg = json!({
                    "type": "file:shared",
                    "id": event.id,
                    "participantId": event.participant_id,
                    "uploaderName": event.uploader_name,
                    "role": event.role,
                    "name": event.name,
                    "size": event.size,
                    "mime": event.mime,
                    "ts": event.ts,
                })
                .to_string();
                broadcast_to_room(&WS_ROOMS, &event.slug, &msg).await;
            }
        });
    }

    // file:removed
    {
        let mut rx = state.events.file_unshared.subscribe();
        tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                let msg = json!({
                    "type": "file:removed",
                    "id": event.id,
                })
                .to_string();
                broadcast_to_room(&WS_ROOMS, &event.slug, &msg).await;
            }
        });
    }

    // participant:kicked
    {
        let mut rx = state.events.participant_kicked.subscribe();
        tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                let msg = json!({"type": "kicked"}).to_string();
                send_to_participant_and_close(&WS_ROOMS, &event.slug, &event.participant_id, &msg)
                    .await;

                // Broadcast updated participants after removal
                broadcast_participants(&WS_ROOMS, &event.slug).await;
            }
        });
    }

    // host:revoked — presenter_key rotation force-rejoins existing hosts.
    {
        let mut rx = state.events.host_revoked.subscribe();
        tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                let msg = json!({"type": "host:revoked"}).to_string();
                send_to_participant_and_close(&WS_ROOMS, &event.slug, &event.participant_id, &msg)
                    .await;
                broadcast_participants(&WS_ROOMS, &event.slug).await;
            }
        });
    }
}
