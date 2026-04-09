use std::env;

#[derive(Clone)]
pub struct AppConfig {
    pub jwt_secret: String,
    pub ome_webhook_secret: String,
    pub ome_api_url: String,
    pub ome_api_token: String,
    pub livekit_api_key: String,
    pub livekit_api_secret: String,
    pub livekit_internal_url: String,
    pub livekit_url: String,
    pub port: u16,
    pub db_path: String,
    pub data_path: String,
}

impl AppConfig {
    pub fn from_env() -> Self {
        let jwt_secret = env::var("JWT_SECRET").expect("FATAL: JWT_SECRET must be set");
        if jwt_secret.len() < 32 {
            panic!("FATAL: JWT_SECRET must be at least 32 chars");
        }
        let admin_password = env::var("ADMIN_PASSWORD").expect("FATAL: ADMIN_PASSWORD must be set");
        if admin_password.is_empty() {
            panic!("FATAL: ADMIN_PASSWORD must not be empty");
        }
        let ome_webhook_secret = env::var("OME_WEBHOOK_SECRET").expect("FATAL: OME_WEBHOOK_SECRET must be set");

        Self {
            jwt_secret,
            ome_webhook_secret,
            ome_api_url: env::var("OME_API_URL").unwrap_or_else(|_| "http://stream-ome:8081/v1".into()),
            ome_api_token: env::var("OME_API_TOKEN").unwrap_or_default(),
            livekit_api_key: env::var("LIVEKIT_API_KEY").unwrap_or_default(),
            livekit_api_secret: env::var("LIVEKIT_API_SECRET").unwrap_or_default(),
            livekit_internal_url: env::var("LIVEKIT_INTERNAL_URL").unwrap_or_else(|_| "http://stream-livekit:7880".into()),
            livekit_url: env::var("LIVEKIT_URL").unwrap_or_else(|_| "ws://localhost:7880".into()),
            port: env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(4001),
            db_path: env::var("DB_PATH").unwrap_or_else(|_| "/data/stream.db".into()),
            data_path: env::var("DATA_PATH").unwrap_or_else(|_| "/data".into()),
        }
    }
}
