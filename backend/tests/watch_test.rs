mod common;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha1::Sha1;

type HmacSha1 = Hmac<Sha1>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Seed a room that has a stream key assigned, returning (room_id, key_token).
fn seed_room_with_key(
    state: &std::sync::Arc<stream_backend::state::AppState>,
    name: &str,
    slug: &str,
    status: &str,
) -> (String, String) {
    let (key_id, key_token) = common::seed_stream_key(state, &format!("{}-key", slug));
    let room_id = common::seed_room_full(state, name, slug, status, false, Some(&key_id));
    (room_id, key_token)
}

fn set_room_password(
    state: &std::sync::Arc<stream_backend::state::AppState>,
    room_id: &str,
    password: &str,
) {
    let conn = state.db.get().unwrap();
    let hash = bcrypt::hash(password, 4).unwrap();
    conn.execute(
        "UPDATE rooms SET password_hash = ?1 WHERE id = ?2",
        rusqlite::params![hash, room_id],
    )
    .unwrap();
}

fn set_room_expiry(
    state: &std::sync::Arc<stream_backend::state::AppState>,
    room_id: &str,
    expires_at: &str,
) {
    let conn = state.db.get().unwrap();
    conn.execute(
        "UPDATE rooms SET expires_at = ?1 WHERE id = ?2",
        rusqlite::params![expires_at, room_id],
    )
    .unwrap();
}

/// Recompute the expected HMAC-SHA1 signature for a `signed` streamid prefix
/// (`default/live/<key>?policy=<...>`), to validate the endpoint's signing.
fn expected_signature(secret: &str, signed: &str) -> String {
    let mut mac = HmacSha1::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(signed.as_bytes());
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn unknown_slug_returns_404() {
    let state = common::test_state();
    let server = common::test_app(state);

    let res = server.get("/api/watch/does-not-exist").await;
    assert_eq!(res.status_code(), 404);
}

#[tokio::test]
async fn room_without_stream_key_returns_404() {
    let state = common::test_state();
    let server = common::test_app(state.clone());

    common::seed_room(&state, "No Key", "watch-no-key");

    let res = server.get("/api/watch/watch-no-key").await;
    assert_eq!(res.status_code(), 404);
}

#[tokio::test]
async fn ended_room_returns_404() {
    let state = common::test_state();
    let server = common::test_app(state.clone());

    seed_room_with_key(&state, "Ended", "watch-ended", "ended");

    let res = server.get("/api/watch/watch-ended").await;
    assert_eq!(res.status_code(), 404);
}

#[tokio::test]
async fn expired_room_returns_404() {
    let state = common::test_state();
    let server = common::test_app(state.clone());

    let (room_id, _key) = seed_room_with_key(&state, "Expired", "watch-expired", "live");
    set_room_expiry(&state, &room_id, "2020-01-01 00:00:00");

    let res = server.get("/api/watch/watch-expired").await;
    assert_eq!(res.status_code(), 404);
}

#[tokio::test]
async fn returns_signed_srt_details() {
    let state = common::test_state();
    let server = common::test_app(state.clone());

    let (_room_id, key_token) = seed_room_with_key(&state, "Project X", "watch-ok", "live");

    let res = server.get("/api/watch/watch-ok").await;
    assert_eq!(res.status_code(), 200);

    let body: Value = res.json();

    // Shape
    assert_eq!(body["srt"]["host"], "stream.example.com");
    assert_eq!(body["srt"]["port"], 9998);
    assert_eq!(body["srt"]["latency"], 500);
    assert_eq!(body["ttlSeconds"], 30);
    assert_eq!(body["title"], "Project X");

    // streamid: default/live/<key>?policy=<b64url>&signature=<b64url-hmac>
    let streamid = body["srt"]["streamid"].as_str().unwrap();
    let (signed, sig) = streamid.split_once("&signature=").unwrap();
    assert!(signed.starts_with(&format!("default/live/{}?policy=", key_token)));

    // Signature matches an independent recompute with the test secret.
    let expected = expected_signature(&state.config.ome_signed_policy_secret, signed);
    assert_eq!(sig, expected);

    // Policy decodes to a JSON object carrying a future url_expire (epoch ms).
    let policy_b64 = signed.split("?policy=").nth(1).unwrap();
    let policy_json = String::from_utf8(URL_SAFE_NO_PAD.decode(policy_b64).unwrap()).unwrap();
    let policy: Value = serde_json::from_str(&policy_json).unwrap();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    assert!(policy["url_expire"].as_u64().unwrap() > now_ms);
}

#[tokio::test]
async fn password_room_requires_password() {
    let state = common::test_state();
    let server = common::test_app(state.clone());

    let (room_id, _key) = seed_room_with_key(&state, "Locked", "watch-locked", "live");
    set_room_password(&state, &room_id, "s3cret");

    // Missing password → 403
    let res = server.get("/api/watch/watch-locked").await;
    assert_eq!(res.status_code(), 403);

    // Wrong password → 403
    let res = server.get("/api/watch/watch-locked?password=nope").await;
    assert_eq!(res.status_code(), 403);

    // Correct password → 200
    let res = server.get("/api/watch/watch-locked?password=s3cret").await;
    assert_eq!(res.status_code(), 200);
}
