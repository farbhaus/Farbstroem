use axum::{
    extract::{Path, State},
    routing::{delete, get},
    Json, Router,
};
use base64::Engine;
use serde_json::Value;
use std::sync::Arc;

use crate::auth::AdminAuth;
use crate::error::AppError;
use crate::state::AppState;

async fn ome_request(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    method: reqwest::Method,
    path: &str,
) -> Result<Value, AppError> {
    let url = format!("{}{}", base_url, path);
    let basic = base64::engine::general_purpose::STANDARD.encode(token);

    let resp = client
        .request(method, &url)
        .header("Authorization", format!("Basic {}", basic))
        .send()
        .await
        .map_err(|e| AppError::BadGateway(format!("OME request failed: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::BadGateway(format!(
            "OME returned {}: {}",
            status, body
        )));
    }

    let json = resp
        .json::<Value>()
        .await
        .map_err(|e| AppError::BadGateway(format!("OME invalid JSON: {}", e)))?;

    Ok(json)
}

async fn get_status(
    _auth: AdminAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, AppError> {
    let ome_data = ome_request(
        &state.http_client,
        &state.config.ome_api_url,
        &state.config.ome_api_token,
        reqwest::Method::GET,
        "/vhosts/default/apps/app/streams",
    )
    .await?;

    // Extract stream names from OME response
    let stream_names: Vec<String> = ome_data
        .pointer("/response")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s.get("name").and_then(|n| n.as_str()).map(String::from))
                .filter(|name| !name.starts_with("conf-"))
                .collect()
        })
        .unwrap_or_default();

    // Enrich with DB data
    let conn = state.db.get()?;
    let enriched = tokio::task::spawn_blocking(move || {
        let mut results = Vec::new();
        for stream_name in &stream_names {
            let mut stmt = conn.prepare(
                "SELECT sk.name as key_name, r.name as room_name, r.id as room_id, r.slug \
                 FROM stream_keys sk \
                 LEFT JOIN rooms r ON r.stream_key_id = sk.id \
                 WHERE sk.key_token = ?1",
            )?;
            let row = stmt
                .query_row(rusqlite::params![stream_name], |row| {
                    Ok(serde_json::json!({
                        "stream": stream_name,
                        "key_name": row.get::<_, Option<String>>(0)?,
                        "room_name": row.get::<_, Option<String>>(1)?,
                        "room_id": row.get::<_, Option<String>>(2)?,
                        "slug": row.get::<_, Option<String>>(3)?,
                    }))
                })
                .unwrap_or_else(|_| {
                    serde_json::json!({
                        "stream": stream_name,
                        "key_name": null,
                        "room_name": null,
                        "room_id": null,
                        "slug": null,
                    })
                });
            results.push(row);
        }
        Ok::<_, rusqlite::Error>(results)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;

    Ok(Json(serde_json::json!({ "streams": enriched })))
}

async fn list_streams(
    _auth: AdminAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, AppError> {
    let data = ome_request(
        &state.http_client,
        &state.config.ome_api_url,
        &state.config.ome_api_token,
        reqwest::Method::GET,
        "/vhosts/default/apps/app/streams",
    )
    .await?;

    Ok(Json(data))
}

async fn get_stream(
    _auth: AdminAuth,
    State(state): State<Arc<AppState>>,
    Path(stream_key): Path<String>,
) -> Result<Json<Value>, AppError> {
    let path = format!("/vhosts/default/apps/app/streams/{}", stream_key);
    let data = ome_request(
        &state.http_client,
        &state.config.ome_api_url,
        &state.config.ome_api_token,
        reqwest::Method::GET,
        &path,
    )
    .await?;

    Ok(Json(data))
}

async fn delete_stream(
    _auth: AdminAuth,
    State(state): State<Arc<AppState>>,
    Path(stream_key): Path<String>,
) -> Result<Json<Value>, AppError> {
    let path = format!("/vhosts/default/apps/app/streams/{}", stream_key);
    let data = ome_request(
        &state.http_client,
        &state.config.ome_api_url,
        &state.config.ome_api_token,
        reqwest::Method::DELETE,
        &path,
    )
    .await?;

    Ok(Json(data))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/status", get(get_status))
        .route("/streams", get(list_streams))
        .route("/streams/{streamKey}", get(get_stream).delete(delete_stream))
}
