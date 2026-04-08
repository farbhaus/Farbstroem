use crate::config::AppConfig;
use crate::db::DbPool;
use crate::events::EventChannels;
use std::sync::Arc;

pub type SharedState = Arc<AppState>;

pub struct AppState {
    pub db: DbPool,
    pub events: EventChannels,
    pub config: AppConfig,
    pub http_client: reqwest::Client,
    pub admin_password_hash: String,
}
