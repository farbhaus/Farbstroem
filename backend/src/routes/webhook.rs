use axum::{body::Bytes, extract::State, http::HeaderMap, routing::post, Json, Router};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use rusqlite::params;
use serde_json::{json, Value};
use sha1::Sha1;
use std::sync::Arc;
use subtle::ConstantTimeEq;

use crate::error::AppError;
use crate::state::AppState;

type HmacSha1 = Hmac<Sha1>;

fn extract_stream_key(url: &str) -> Option<String> {
    let url_str = if url.starts_with("http") || url.starts_with("rtmp") {
        url.to_string()
    } else {
        format!("http://x{}", url)
    };
    let path = if let Some(pos) = url_str.find("://") {
        let after_scheme = &url_str[pos + 3..];
        after_scheme
            .find('/')
            .map(|p| &after_scheme[p..])
            .unwrap_or("")
    } else {
        &url_str
    };
    let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    parts
        .last()
        .map(|s| s.split('?').next().unwrap_or(s).to_string())
}

async fn webhook_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, AppError> {
    // Verify HMAC signature
    let signature = headers
        .get("x-ome-signature")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized("Missing signature".into()))?;

    let secret = &state.config.ome_webhook_secret;
    let mut mac = HmacSha1::new_from_slice(secret.as_bytes())
        .map_err(|e| AppError::Internal(format!("HMAC init error: {}", e)))?;
    mac.update(&body);
    let result = mac.finalize().into_bytes();
    let expected = URL_SAFE_NO_PAD.encode(result);

    if expected.as_bytes().ct_eq(signature.as_bytes()).unwrap_u8() == 0 {
        return Err(AppError::Unauthorized("Invalid signature".into()));
    }

    // Parse body as JSON
    let payload: Value =
        serde_json::from_slice(&body).map_err(|e| AppError::BadRequest(e.to_string()))?;

    let request = payload
        .get("request")
        .ok_or_else(|| AppError::BadRequest("Missing request object".into()))?;

    let direction = request
        .get("direction")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if direction != "incoming" {
        return Ok(Json(json!({ "allowed": true })));
    }

    // Extract stream key from URL
    let url = request.get("url").and_then(|v| v.as_str()).unwrap_or("");

    let stream_key = extract_stream_key(url)
        .ok_or_else(|| AppError::BadRequest("Cannot extract stream key".into()))?;

    // Look up stream key and update rooms
    let events = state.events.clone();
    let conn = state.db.get()?;
    let slugs = tokio::task::spawn_blocking(move || {
        // Find rooms with this stream key
        let mut stmt = conn.prepare(
            "SELECT r.id, r.slug FROM rooms r \
             JOIN stream_keys sk ON sk.id = r.stream_key_id \
             WHERE sk.key_token = ?1",
        )?;
        let rooms: Vec<(String, String)> = stmt
            .query_map(params![stream_key], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut slugs = Vec::new();
        for (room_id, slug) in &rooms {
            conn.execute(
                "UPDATE rooms SET status = 'live' WHERE id = ?1",
                params![room_id],
            )?;
            slugs.push(slug.clone());
        }
        Ok::<_, rusqlite::Error>(slugs)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;

    // Emit room:live events
    for slug in &slugs {
        let _ = events.room_live.send(slug.clone());
    }

    Ok(Json(json!({ "allowed": true })))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/", post(webhook_handler))
}
