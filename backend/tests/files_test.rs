mod common;

use serde_json::Value;

#[tokio::test]
async fn files_list_returns_401_without_auth() {
    let state = common::test_state();
    let room_id = common::seed_room(&state, "File Room", "files-no-auth");
    let _ = room_id;
    let server = common::test_app(state);
    let res = server.get("/api/public/rooms/files-no-auth/files").await;
    assert_eq!(res.status_code(), 401);
}

#[tokio::test]
async fn files_list_returns_401_invalid_token() {
    let state = common::test_state();
    let _room_id = common::seed_room(&state, "File Room", "files-bad-token");
    let server = common::test_app(state);
    let res = server
        .get("/api/public/rooms/files-bad-token/files?participantId=fake-id&token=fake-token")
        .await;
    assert_eq!(res.status_code(), 401);
}

#[tokio::test]
async fn files_list_returns_empty_for_valid_participant() {
    let state = common::test_state();
    let room_id = common::seed_room(&state, "File Room", "files-empty-list");
    let (pid, token) = common::seed_participant(&state, &room_id, "Viewer", "viewer", true, false);
    let server = common::test_app(state);
    let url = format!(
        "/api/public/rooms/files-empty-list/files?participantId={}&token={}",
        pid, token
    );
    let res = server.get(&url).await;
    assert_eq!(res.status_code(), 200);
    let body: Vec<Value> = res.json();
    assert!(body.is_empty());
}

#[tokio::test]
async fn files_list_returns_401_for_kicked_participant() {
    let state = common::test_state();
    let room_id = common::seed_room(&state, "File Room", "files-kicked");
    let (pid, token) = common::seed_participant(&state, &room_id, "Kicked", "viewer", true, true);
    let server = common::test_app(state);
    let url = format!(
        "/api/public/rooms/files-kicked/files?participantId={}&token={}",
        pid, token
    );
    let res = server.get(&url).await;
    assert_eq!(res.status_code(), 401);
}

#[tokio::test]
async fn files_download_returns_401_without_auth() {
    let state = common::test_state();
    let _room_id = common::seed_room(&state, "File Room", "files-dl-noauth");
    let server = common::test_app(state);
    let res = server
        .get("/api/public/rooms/files-dl-noauth/files/some-file-id/download")
        .await;
    assert_eq!(res.status_code(), 401);
}

#[tokio::test]
async fn files_download_returns_404_nonexistent_file() {
    let state = common::test_state();
    let room_id = common::seed_room(&state, "File Room", "files-dl-404");
    let (pid, token) = common::seed_participant(&state, &room_id, "Viewer", "viewer", true, false);
    let server = common::test_app(state);
    let url = format!(
        "/api/public/rooms/files-dl-404/files/nonexistent-id/download?participantId={}&token={}",
        pid, token
    );
    let res = server.get(&url).await;
    assert_eq!(res.status_code(), 404);
}
