mod common;

use axum::http::header;
use serde_json::{json, Value};

fn auth_header(token: &str) -> (axum::http::HeaderName, axum::http::HeaderValue) {
    (
        header::AUTHORIZATION,
        format!("Bearer {}", token).parse().unwrap(),
    )
}

// ---------------------------------------------------------------------------
// List rooms
// ---------------------------------------------------------------------------

#[tokio::test]
async fn list_rooms_returns_401_without_auth() {
    let state = common::test_state();
    let server = common::test_app(state);

    let res = server.get("/api/rooms").await;
    assert_eq!(res.status_code(), 401);
}

#[tokio::test]
async fn list_rooms_returns_empty() {
    let state = common::test_state();
    let server = common::test_app(state.clone());
    let token = common::admin_token(&state);
    let (name, val) = auth_header(&token);

    let res = server.get("/api/rooms").add_header(name, val).await;
    assert_eq!(res.status_code(), 200);

    let body: Vec<Value> = res.json();
    assert!(body.is_empty());
}

// ---------------------------------------------------------------------------
// Create room
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_room_returns_400_without_name() {
    let state = common::test_state();
    let server = common::test_app(state.clone());
    let token = common::admin_token(&state);
    let (name, val) = auth_header(&token);

    let res = server
        .post("/api/rooms")
        .add_header(name, val)
        .json(&json!({}))
        .await;
    assert_eq!(res.status_code(), 400);
}

#[tokio::test]
async fn create_room_succeeds() {
    let state = common::test_state();
    let server = common::test_app(state.clone());
    let token = common::admin_token(&state);
    let (name, val) = auth_header(&token);

    let res = server
        .post("/api/rooms")
        .add_header(name, val)
        .json(&json!({ "name": "Test Room" }))
        .await;
    assert_eq!(res.status_code(), 200);

    let body: Value = res.json();
    assert!(body.get("id").is_some());
    assert!(body.get("slug").is_some());
    assert_eq!(body["status"], "pending");
    assert_eq!(body["delivery_mode"], "webrtc");
    assert!(body.get("presenter_key").is_some());
    assert_eq!(body["name"], "Test Room");
}

// ---------------------------------------------------------------------------
// Get room
// ---------------------------------------------------------------------------

#[tokio::test]
async fn get_room_returns_404() {
    let state = common::test_state();
    let server = common::test_app(state.clone());
    let token = common::admin_token(&state);
    let (name, val) = auth_header(&token);

    let res = server
        .get("/api/rooms/nonexistent-id")
        .add_header(name, val)
        .await;
    assert_eq!(res.status_code(), 404);
}

#[tokio::test]
async fn get_room_succeeds() {
    let state = common::test_state();
    let server = common::test_app(state.clone());
    let token = common::admin_token(&state);

    let room_id = common::seed_room(&state, "My Room", "my-room-abc123");

    let (name, val) = auth_header(&token);
    let res = server
        .get(&format!("/api/rooms/{}", room_id))
        .add_header(name, val)
        .await;
    assert_eq!(res.status_code(), 200);

    let body: Value = res.json();
    assert_eq!(body["id"], room_id);
    assert_eq!(body["name"], "My Room");
    assert_eq!(body["slug"], "my-room-abc123");
}

// ---------------------------------------------------------------------------
// Update room
// ---------------------------------------------------------------------------

#[tokio::test]
async fn update_room_returns_404() {
    let state = common::test_state();
    let server = common::test_app(state.clone());
    let token = common::admin_token(&state);
    let (name, val) = auth_header(&token);

    let res = server
        .put("/api/rooms/nonexistent-id")
        .add_header(name, val)
        .json(&json!({ "name": "New Name" }))
        .await;
    assert_eq!(res.status_code(), 404);
}

#[tokio::test]
async fn update_room_changes_name() {
    let state = common::test_state();
    let server = common::test_app(state.clone());
    let token = common::admin_token(&state);

    let room_id = common::seed_room(&state, "Old Name", "old-name-abc123");

    let (name, val) = auth_header(&token);
    let res = server
        .put(&format!("/api/rooms/{}", room_id))
        .add_header(name, val)
        .json(&json!({ "name": "New Name" }))
        .await;
    assert_eq!(res.status_code(), 200);

    let body: Value = res.json();
    assert_eq!(body["name"], "New Name");
}

// ---------------------------------------------------------------------------
// End room
// ---------------------------------------------------------------------------

#[tokio::test]
async fn end_room_succeeds() {
    let state = common::test_state();
    let server = common::test_app(state.clone());
    let token = common::admin_token(&state);

    let room_id = common::seed_room(&state, "Live Room", "live-room-abc123");

    let (name, val) = auth_header(&token);
    let res = server
        .post(&format!("/api/rooms/{}/end", room_id))
        .add_header(name, val)
        .await;
    assert_eq!(res.status_code(), 200);

    let body: Value = res.json();
    assert_eq!(body["ok"], true);

    // Verify status changed to ended
    let (name2, val2) = auth_header(&token);
    let res2 = server
        .get(&format!("/api/rooms/{}", room_id))
        .add_header(name2, val2)
        .await;
    let room: Value = res2.json();
    assert_eq!(room["status"], "ended");
}

// ---------------------------------------------------------------------------
// Delete room
// ---------------------------------------------------------------------------

#[tokio::test]
async fn delete_room_succeeds() {
    let state = common::test_state();
    let server = common::test_app(state.clone());
    let token = common::admin_token(&state);

    let room_id = common::seed_room(&state, "Delete Me", "delete-me-abc123");

    let (name, val) = auth_header(&token);
    let res = server
        .delete(&format!("/api/rooms/{}", room_id))
        .add_header(name, val)
        .await;
    assert_eq!(res.status_code(), 200);

    let body: Value = res.json();
    assert_eq!(body["ok"], true);
}

#[tokio::test]
async fn delete_room_returns_404() {
    let state = common::test_state();
    let server = common::test_app(state.clone());
    let token = common::admin_token(&state);
    let (name, val) = auth_header(&token);

    let res = server
        .delete("/api/rooms/nonexistent-id")
        .add_header(name, val)
        .await;
    assert_eq!(res.status_code(), 404);
}

// ---------------------------------------------------------------------------
// Waiting list
// ---------------------------------------------------------------------------

#[tokio::test]
async fn waiting_list_empty() {
    let state = common::test_state();
    let server = common::test_app(state.clone());
    let token = common::admin_token(&state);

    let room_id = common::seed_room(&state, "Wait Room", "wait-room-abc123");

    let (name, val) = auth_header(&token);
    let res = server
        .get(&format!("/api/rooms/{}/waiting", room_id))
        .add_header(name, val)
        .await;
    assert_eq!(res.status_code(), 200);

    let body: Vec<Value> = res.json();
    assert!(body.is_empty());
}

// ---------------------------------------------------------------------------
// Admit participant
// ---------------------------------------------------------------------------

#[tokio::test]
async fn admit_participant() {
    let state = common::test_state();
    let server = common::test_app(state.clone());
    let token = common::admin_token(&state);

    let room_id = common::seed_room(&state, "Admit Room", "admit-room-abc123");
    let (pid, _ptok) = common::seed_participant(
        &state,
        &room_id,
        "Waiting User",
        "viewer",
        false, // not admitted
        false, // not kicked
    );

    let (name, val) = auth_header(&token);
    let res = server
        .post(&format!("/api/rooms/{}/admit/{}", room_id, pid))
        .add_header(name, val)
        .await;
    assert_eq!(res.status_code(), 200);

    let body: Value = res.json();
    assert_eq!(body["ok"], true);
}

// ---------------------------------------------------------------------------
// Admit all
// ---------------------------------------------------------------------------

#[tokio::test]
async fn admit_all() {
    let state = common::test_state();
    let server = common::test_app(state.clone());
    let token = common::admin_token(&state);

    let room_id = common::seed_room(&state, "Admit All Room", "admit-all-abc123");
    let (_p1, _) = common::seed_participant(&state, &room_id, "User1", "viewer", false, false);
    let (_p2, _) = common::seed_participant(&state, &room_id, "User2", "viewer", false, false);

    let (name, val) = auth_header(&token);
    let res = server
        .post(&format!("/api/rooms/{}/admit-all", room_id))
        .add_header(name, val)
        .await;
    assert_eq!(res.status_code(), 200);

    let body: Value = res.json();
    assert_eq!(body["ok"], true);
}

// ---------------------------------------------------------------------------
// Kicked list and unkick
// ---------------------------------------------------------------------------

#[tokio::test]
async fn kicked_list_and_unkick() {
    let state = common::test_state();
    let server = common::test_app(state.clone());
    let token = common::admin_token(&state);

    let room_id = common::seed_room(&state, "Kick Room", "kick-room-abc123");
    let (pid, _ptok) = common::seed_participant(
        &state,
        &room_id,
        "Kicked User",
        "viewer",
        true, // admitted
        true, // kicked
    );

    // GET kicked list
    let (name, val) = auth_header(&token);
    let res = server
        .get(&format!("/api/rooms/{}/kicked", room_id))
        .add_header(name, val)
        .await;
    assert_eq!(res.status_code(), 200);

    let body: Vec<Value> = res.json();
    assert_eq!(body.len(), 1);
    assert_eq!(body[0]["name"], "Kicked User");

    // POST unkick
    let (name2, val2) = auth_header(&token);
    let res2 = server
        .post(&format!("/api/rooms/{}/unkick/{}", room_id, pid))
        .add_header(name2, val2)
        .await;
    assert_eq!(res2.status_code(), 200);

    let body2: Value = res2.json();
    assert_eq!(body2["ok"], true);

    // Verify kicked list is now empty
    let (name3, val3) = auth_header(&token);
    let res3 = server
        .get(&format!("/api/rooms/{}/kicked", room_id))
        .add_header(name3, val3)
        .await;
    let body3: Vec<Value> = res3.json();
    assert!(body3.is_empty());
}
