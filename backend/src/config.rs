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
    /// Public origin the admin panel is served from, e.g.
    /// `https://stream.yourdomain.com`. Used as the WebAuthn relying-party
    /// origin; the RP ID is the host parsed from it. Set to
    /// `http://localhost:4001` for local dev so passkeys work.
    pub public_origin: String,
}

/// Require an env var to be set, panicking with a clear message if not.
fn required(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("FATAL: {} must be set", name))
}

/// Require an env var to be set and meet a minimum length.
fn required_min_len(name: &str, min_len: usize) -> String {
    let value = required(name);
    if value.len() < min_len {
        panic!("FATAL: {} must be at least {} chars", name, min_len);
    }
    value
}

impl AppConfig {
    pub fn from_env() -> Self {
        // Signing keys — all used as HMAC secrets, enforce 32-char minimum.
        let jwt_secret = required_min_len("JWT_SECRET", 32);
        let ome_webhook_secret = required_min_len("OME_WEBHOOK_SECRET", 32);
        let livekit_api_secret = required_min_len("LIVEKIT_API_SECRET", 32);
        let ome_api_token = required_min_len("OME_API_TOKEN", 32);

        // Admin password is bcrypt-hashed at startup; enforce a sensible minimum.
        let _admin_password = required_min_len("ADMIN_PASSWORD", 12);

        // LiveKit API key is an identifier (becomes the `iss` JWT claim), not a
        // secret — require presence but don't enforce length.
        let livekit_api_key = required("LIVEKIT_API_KEY");

        Self {
            jwt_secret,
            ome_webhook_secret,
            ome_api_url: env::var("OME_API_URL")
                .unwrap_or_else(|_| "http://stream-ome:8081/v1".into()),
            ome_api_token,
            livekit_api_key,
            livekit_api_secret,
            livekit_internal_url: env::var("LIVEKIT_INTERNAL_URL")
                .unwrap_or_else(|_| "http://stream-livekit:7880".into()),
            livekit_url: env::var("LIVEKIT_URL").unwrap_or_else(|_| "ws://localhost:7880".into()),
            port: env::var("PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(4001),
            db_path: env::var("DB_PATH").unwrap_or_else(|_| "/data/stream.db".into()),
            data_path: env::var("DATA_PATH").unwrap_or_else(|_| "/data".into()),
            public_origin: env::var("PUBLIC_ORIGIN")
                .unwrap_or_else(|_| "http://localhost:4001".into()),
        }
    }
}
