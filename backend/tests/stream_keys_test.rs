mod common;

use serde_json::Value;

#[tokio::test]
async fn list_keys_returns_401_without_auth() {
    let state = common::test_state();
    let server = common::test_app(state);
    let res = server.get("/api/stream-keys").await;
    assert_eq!(res.status_code(), 401);
}

#[tokio::test]
async fn list_keys_returns_empty_array() {
    let state = common::test_state();
    let token = common::admin_token(&state);
    let server = common::test_app(state);
    let res = server.get("/api/stream-keys")
        .add_header("Authorization", format!("Bearer {}", token))
        .await;
    assert_eq!(res.status_code(), 200);
    let body: Vec<Value> = res.json();
    assert!(body.is_empty());
}

#[tokio::test]
async fn create_key_returns_400_without_name() {
    let state = common::test_state();
    let token = common::admin_token(&state);
    let server = common::test_app(state);
    let res = server.post("/api/stream-keys")
        .add_header("Authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({}))
        .await;
    assert_eq!(res.status_code(), 400);
}

#[tokio::test]
async fn create_key_returns_201() {
    let state = common::test_state();
    let token = common::admin_token(&state);
    let server = common::test_app(state);
    let res = server.post("/api/stream-keys")
        .add_header("Authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"name": "Test Key"}))
        .await;
    let body: Value = res.json();
    assert!(body.get("id").is_some());
    assert!(body.get("key_token").is_some());
    assert_eq!(body["name"], "Test Key");
}

#[tokio::test]
async fn update_key_returns_404_for_nonexistent() {
    let state = common::test_state();
    let token = common::admin_token(&state);
    let server = common::test_app(state);
    let res = server.put("/api/stream-keys/nonexistent")
        .add_header("Authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"name": "Updated"}))
        .await;
    assert_eq!(res.status_code(), 404);
}

#[tokio::test]
async fn update_key_renames() {
    let state = common::test_state();
    let token = common::admin_token(&state);
    let (key_id, _) = common::seed_stream_key(&state, "Original");
    let server = common::test_app(state);
    let res = server.put(&format!("/api/stream-keys/{}", key_id))
        .add_header("Authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"name": "Renamed"}))
        .await;
    assert_eq!(res.status_code(), 200);
    let body: Value = res.json();
    assert_eq!(body["name"], "Renamed");
}

#[tokio::test]
async fn delete_key_returns_404_for_nonexistent() {
    let state = common::test_state();
    let token = common::admin_token(&state);
    let server = common::test_app(state);
    let res = server.delete("/api/stream-keys/nonexistent")
        .add_header("Authorization", format!("Bearer {}", token))
        .await;
    assert_eq!(res.status_code(), 404);
}

#[tokio::test]
async fn delete_key_succeeds() {
    let state = common::test_state();
    let token = common::admin_token(&state);
    let (key_id, _) = common::seed_stream_key(&state, "To Delete");
    let server = common::test_app(state);
    let res = server.delete(&format!("/api/stream-keys/{}", key_id))
        .add_header("Authorization", format!("Bearer {}", token))
        .await;
    assert_eq!(res.status_code(), 200);
    let body: Value = res.json();
    assert_eq!(body["ok"], true);
}
