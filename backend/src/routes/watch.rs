//! Farbplay ⇄ Farbstroem room-link SRT integration (see GitHub #165).
//!
//! Native SRT viewers (Farbplay) connect from a shared room link
//! `https://<host>/watch/<slug>` instead of a raw `srt://` URL. The app prepends
//! `/api` to the path and `GET`s `/api/watch/<slug>`, expecting SRT connection
//! details with a short-lived, HMAC-signed `streamid` (OME SignedPolicy). It
//! re-fetches on every (re)connect, so a ~30 s TTL is plenty — the token only
//! needs to survive the SRT handshake.
//!
//! Security caveat: in Farbstroem the OME stream name *is* the ingest stream key
//! (`OutputStreamName=${OriginStreamName}`), so the signed streamid necessarily
//! contains `default/live/<key_token>` in plaintext. SignedPolicy here provides
//! expiry / replay-limiting, **not** path secrecy — the key is already handed to
//! web viewers on join. See #165 and the credential-separation follow-up.

use axum::{
    extract::{Path, Query, State},
    routing::get,
    Json, Router,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha1::Sha1;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::AppError;
use crate::state::AppState;

type HmacSha1 = Hmac<Sha1>;

/// Token lifetime. The app re-fetches on every (re)connect, so this only needs
/// to outlast the SRT handshake.
const TTL_SECONDS: u64 = 30;

#[derive(Deserialize)]
struct WatchQuery {
    password: Option<String>,
}

/// Mint an OME SignedPolicy streamid for SRT playback.
///
/// `base = "default/live/<stream>"`, then `?policy=<b64url(json)>` is appended
/// and an HMAC-SHA1 signature over that string is appended as
/// `&signature=<b64url(hmac)>`. OME validates the HMAC + `url_expire` on connect.
fn sign_streamid(secret: &str, stream_name: &str, expire_ms: u128) -> Result<String, AppError> {
    let base = format!("default/live/{}", stream_name);
    let policy_json = json!({ "url_expire": expire_ms }).to_string();
    let policy = URL_SAFE_NO_PAD.encode(policy_json);
    let signed = format!("{}?policy={}", base, policy);

    let mut mac = HmacSha1::new_from_slice(secret.as_bytes())
        .map_err(|e| AppError::Internal(format!("HMAC init error: {}", e)))?;
    mac.update(signed.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());

    Ok(format!("{}&signature={}", signed, signature))
}

/// GET /:slug — return SRT connection details for a room (public).
///
/// 404 for unknown / expired / ended rooms or rooms with no stream key.
/// 403 when the room has a password and a matching `?password=` is not supplied.
async fn watch(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Query(query): Query<WatchQuery>,
) -> Result<Json<Value>, AppError> {
    let conn = state.db.get()?;
    let slug_clone = slug.clone();
    // Filter ended/expired rooms in SQL: both collapse to "no row" → 404, which
    // is exactly what the contract wants for unknown *and* expired rooms.
    // `expires_at` is stored as a UTC "YYYY-MM-DD HH:MM:SS" string (see
    // rooms::normalize_datetime), so it compares directly against CURRENT_TIMESTAMP.
    let (room_name, password_hash, key_token) = tokio::task::spawn_blocking(move || {
        let mut stmt = conn.prepare(
            "SELECT r.name, r.password_hash, sk.key_token \
             FROM rooms r \
             LEFT JOIN stream_keys sk ON sk.id = r.stream_key_id \
             WHERE r.slug = ?1 \
               AND r.status != 'ended' \
               AND (r.expires_at IS NULL OR r.expires_at > CURRENT_TIMESTAMP)",
        )?;
        stmt.query_row(rusqlite::params![slug_clone], |row| {
            Ok((
                row.get::<_, String>(0)?,         // name
                row.get::<_, Option<String>>(1)?, // password_hash
                row.get::<_, Option<String>>(2)?, // stream key_token
            ))
        })
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("Room not found".into()),
            _ => AppError::Internal(e.to_string()),
        })
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;

    // 404 if no stream key is assigned — there is nothing to watch.
    let stream_name = key_token.ok_or_else(|| AppError::NotFound("Room not found".into()))?;

    // 403 if the room is password-protected and the query password is missing
    // or wrong. (Farbplay can't supply a password, so password rooms are not
    // reachable via the bare link — intentional, see #165.)
    if let Some(hash) = password_hash.filter(|h| !h.is_empty()) {
        let provided = query.password.unwrap_or_default();
        if provided.is_empty() {
            return Err(AppError::Forbidden("Password required".into()));
        }
        let valid = tokio::task::spawn_blocking(move || bcrypt::verify(provided, &hash))
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?
            .map_err(|_| AppError::Forbidden("Wrong password".into()))?;
        if !valid {
            return Err(AppError::Forbidden("Wrong password".into()));
        }
    }

    let expire_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        + (TTL_SECONDS as u128 * 1000);
    let streamid = sign_streamid(
        &state.config.ome_signed_policy_secret,
        &stream_name,
        expire_ms,
    )?;

    Ok(Json(json!({
        "srt": {
            "host": state.config.srt_public_host,
            "port": state.config.srt_public_port,
            "streamid": streamid,
            "latency": state.config.srt_latency_ms,
        },
        "ttlSeconds": TTL_SECONDS,
        "title": room_name,
    })))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/{slug}", get(watch))
}
