use axum::{
    extract::{FromRequestParts, Query},
    http::{request::Parts, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use std::collections::HashMap;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation, Algorithm};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use crate::state::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct AdminClaims {
    pub admin: bool,
    pub exp: usize,
}

/// Extractor that validates JWT Bearer token from Authorization header.
pub struct AdminAuth(pub AdminClaims);

impl FromRequestParts<Arc<AppState>> for AdminAuth {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &Arc<AppState>) -> Result<Self, Self::Rejection> {
        let auth_header = parts
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok());

        let header_token = match auth_header {
            Some(h) if h.starts_with("Bearer ") => Some(h[7..].to_string()),
            _ => None,
        };

        // Fall back to ?token=… query param so <img>/<video>/<iframe>/window.open
        // can hit authenticated endpoints (admin preview/download) without a
        // way to attach headers.
        let query_token = Query::<HashMap<String, String>>::from_request_parts(parts, state)
            .await
            .ok()
            .and_then(|Query(m)| m.get("token").cloned());

        let token = match header_token.or(query_token) {
            Some(t) => t,
            None => {
                return Err((
                    StatusCode::UNAUTHORIZED,
                    Json(json!({ "error": "Unauthorised" })),
                ).into_response());
            }
        };

        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_required_spec_claims(&["exp"]);

        match decode::<AdminClaims>(
            &token,
            &DecodingKey::from_secret(state.config.jwt_secret.as_bytes()),
            &validation,
        ) {
            Ok(data) => Ok(AdminAuth(data.claims)),
            Err(_) => Err((
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "Invalid or expired token" })),
            ).into_response()),
        }
    }
}

pub fn create_admin_token(secret: &str) -> Result<String, jsonwebtoken::errors::Error> {
    let exp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as usize
        + 7 * 24 * 60 * 60; // 7 days

    let claims = AdminClaims { admin: true, exp };
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
}
