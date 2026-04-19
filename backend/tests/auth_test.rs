mod common;

use serde_json::Value;

#[tokio::test]
async fn login_returns_400_without_password() {
    let state = common::test_state();
    let server = common::test_app(state);
    let res = server
        .post("/api/auth/login")
        .json(&serde_json::json!({}))
        .await;
    assert_eq!(res.status_code(), 400);
}

#[tokio::test]
async fn login_returns_401_wrong_password() {
    let state = common::test_state();
    let server = common::test_app(state);
    let res = server
        .post("/api/auth/login")
        .json(&serde_json::json!({"password": "wrong"}))
        .await;
    assert_eq!(res.status_code(), 401);
}

#[tokio::test]
async fn login_returns_token_on_correct_password() {
    let state = common::test_state();
    let server = common::test_app(state);
    let res = server
        .post("/api/auth/login")
        .json(&serde_json::json!({"password": "test-admin-password"}))
        .await;
    assert_eq!(res.status_code(), 200);
    let body: Value = res.json();
    assert!(body.get("token").is_some());
}

#[tokio::test]
async fn logout_returns_ok() {
    let state = common::test_state();
    let server = common::test_app(state);
    let res = server.post("/api/auth/logout").await;
    assert_eq!(res.status_code(), 200);
    let body: Value = res.json();
    assert_eq!(body["ok"], true);
}
