use axum::{
    extract::{Multipart, Path, State},
    http::{header, StatusCode},
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
use rusqlite::params;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::auth::AdminAuth;
use crate::error::AppError;
use crate::state::AppState;

async fn get_branding_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, AppError> {
    let data_path = state.config.data_path.clone();
    let has_logo =
        tokio::fs::metadata(format!("{}/branding/logo", data_path))
            .await
            .is_ok();
    let has_bg =
        tokio::fs::metadata(format!("{}/branding/bg", data_path))
            .await
            .is_ok();

    Ok(Json(json!({
        "hasLogo": has_logo,
        "hasBg": has_bg,
    })))
}

async fn get_asset(
    State(state): State<Arc<AppState>>,
    Path(asset): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    if asset != "logo" && asset != "bg" {
        return Err(AppError::NotFound("Asset not found".into()));
    }

    let file_path = format!("{}/branding/{}", state.config.data_path, asset);
    let data = tokio::fs::read(&file_path)
        .await
        .map_err(|_| AppError::NotFound("Asset not found".into()))?;

    // Get MIME type from settings
    let key = format!("{}_mime", asset);
    let conn = state.db.get()?;
    let mime: String = tokio::task::spawn_blocking(move || {
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| "application/octet-stream".into())
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, mime),
            (
                header::CACHE_CONTROL,
                "public, max-age=3600".into(),
            ),
        ],
        data,
    ))
}

async fn upload_asset(
    _auth: AdminAuth,
    State(state): State<Arc<AppState>>,
    Path(asset): Path<String>,
    mut multipart: Multipart,
) -> Result<Json<Value>, AppError> {
    if asset != "logo" && asset != "bg" {
        return Err(AppError::BadRequest("Invalid asset type".into()));
    }

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?
    {
        if field.name() == Some("file") {
            let mime = field
                .content_type()
                .unwrap_or("application/octet-stream")
                .to_string();
            let data = field
                .bytes()
                .await
                .map_err(|e| AppError::BadRequest(e.to_string()))?;

            let dir = format!("{}/branding", state.config.data_path);
            tokio::fs::create_dir_all(&dir)
                .await
                .map_err(|e| AppError::Internal(e.to_string()))?;
            tokio::fs::write(format!("{}/{}", dir, asset), &data)
                .await
                .map_err(|e| AppError::Internal(e.to_string()))?;

            // Store MIME in settings
            let key = format!("{}_mime", asset);
            let conn = state.db.get()?;
            tokio::task::spawn_blocking(move || {
                conn.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
                    params![key, mime],
                )
            })
            .await
            .map_err(|e| AppError::Internal(e.to_string()))??;

            return Ok(Json(json!({ "ok": true })));
        }
    }

    Err(AppError::BadRequest("No file".into()))
}

async fn delete_asset(
    _auth: AdminAuth,
    State(state): State<Arc<AppState>>,
    Path(asset): Path<String>,
) -> Result<Json<Value>, AppError> {
    if asset != "logo" && asset != "bg" {
        return Err(AppError::BadRequest("Invalid asset type".into()));
    }

    let file_path = format!("{}/branding/{}", state.config.data_path, asset);
    let _ = tokio::fs::remove_file(&file_path).await;

    // Remove MIME setting
    let key = format!("{}_mime", asset);
    let conn = state.db.get()?;
    tokio::task::spawn_blocking(move || {
        conn.execute("DELETE FROM settings WHERE key = ?1", params![key])
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;

    Ok(Json(json!({ "ok": true })))
}

pub fn public_router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(get_branding_status))
        .route("/:asset", get(get_asset))
}

pub fn admin_router() -> Router<Arc<AppState>> {
    Router::new().route("/:asset", post(upload_asset).delete(delete_asset))
}
