use stream_backend::config;
use stream_backend::db;
use stream_backend::events;
use stream_backend::state;
use stream_backend::routes;
use stream_backend::ws;
use stream_backend::tasks;

use std::sync::Arc;
use std::net::SocketAddr;
use tower_http::trace::TraceLayer;
use tower_http::services::{ServeDir, ServeFile};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse().unwrap()))
        .init();

    // Load .env file (optional, for local dev)
    let _ = dotenvy::dotenv();

    // Load and validate config (panics on missing required vars)
    let config = config::AppConfig::from_env();
    let port = config.port;

    // Hash admin password at startup (same as Node.js: hash once, then forget plaintext)
    let admin_password = std::env::var("ADMIN_PASSWORD").expect("ADMIN_PASSWORD must be set");
    let admin_password_hash = tokio::task::spawn_blocking(move || {
        bcrypt::hash(admin_password, 12).expect("Failed to hash admin password")
    }).await.unwrap();
    tracing::info!("[startup] Admin password hashed");

    // Initialize database
    let db = db::init_pool(&config.db_path);

    // Create shared state
    let events = events::EventChannels::new();
    let http_client = reqwest::Client::new();
    let state = Arc::new(state::AppState {
        db,
        events,
        config,
        http_client,
        admin_password_hash,
    });

    // Ensure branding directory exists
    let branding_dir = format!("{}/branding", state.config.data_path);
    tokio::fs::create_dir_all(&branding_dir).await.ok();

    // Spawn background tasks
    tasks::spawn_ome_poller(state.clone());
    tasks::spawn_expiry_poller(state.clone());
    tasks::spawn_weekly_cleanup(state.clone());
    tasks::spawn_room_ended_cleanup(state.clone());

    // Spawn WebSocket event listeners
    ws::spawn_event_listeners(state.clone());

    // Build router
    let api_router = routes::build_router(state.clone());

    // Merge WS routes
    let ws_router = ws::router();

    // Build final app with static file serving
    let app = axum::Router::new()
        .merge(api_router)
        .merge(ws_router.with_state(state.clone()))
        .nest_service("/admin", ServeDir::new("/www/admin").fallback(ServeFile::new("/www/admin/index.html")))
        .fallback_service(ServeDir::new("/www/viewer").fallback(ServeFile::new("/www/viewer/index.html")))
        .layer(TraceLayer::new_for_http());

    // Start server
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("stream-backend running on port {}", port);
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
