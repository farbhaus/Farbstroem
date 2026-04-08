use axum::{extract::State, routing::post, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::auth::create_admin_token;
use crate::error::AppError;
use crate::state::AppState;

#[derive(Deserialize)]
struct LoginBody {
    password: Option<String>,
}

async fn login(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LoginBody>,
) -> Result<Json<Value>, AppError> {
    let password = body
        .password
        .ok_or_else(|| AppError::BadRequest("Password required".into()))?;

    if state.admin_password_hash.is_empty() {
        return Err(AppError::Internal("Server misconfigured".into()));
    }

    let hash = state.admin_password_hash.clone();
    let valid = tokio::task::spawn_blocking(move || bcrypt::verify(password, &hash))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(|_| AppError::Unauthorized("Wrong password".into()))?;

    if !valid {
        return Err(AppError::Unauthorized("Wrong password".into()));
    }

    let token = create_admin_token(&state.config.jwt_secret)?;
    Ok(Json(json!({ "token": token })))
}

async fn logout() -> Json<Value> {
    Json(json!({ "ok": true }))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/login", post(login))
        .route("/logout", post(logout))
}
