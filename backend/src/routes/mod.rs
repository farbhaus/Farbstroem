pub mod auth;
pub mod branding;
pub mod files;
pub mod ome;
pub mod rooms;
pub mod rooms_public;
pub mod stream_keys;
pub mod webhook;

use axum::Router;
use std::sync::Arc;

use crate::state::AppState;

pub fn build_router(state: Arc<AppState>) -> Router {
    let api = Router::new()
        .nest("/api/auth", auth::router())
        .nest("/api/stream-keys", stream_keys::router())
        .nest("/api/rooms", rooms::router())
        .nest("/api/ome", ome::router())
        .nest("/api/public/rooms", rooms_public::router())
        .nest("/api/public/rooms", files::router())
        .nest("/api/webhook/admission", webhook::router())
        .nest("/api/branding", branding::public_router())
        .nest("/api/admin/branding", branding::admin_router());

    api.with_state(state)
}
