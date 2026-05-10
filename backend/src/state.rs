use crate::config::AppConfig;
use crate::db::DbPool;
use crate::events::EventChannels;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;

pub type SharedState = Arc<AppState>;

/// Last sample of cumulative network counters and CPU jiffies, used by the
/// metrics handler to compute rates/percentages over the interval since the
/// previous request.
#[derive(Default)]
pub struct MetricsSamples {
    pub net: Option<(u64, u64, Instant)>, // (rx_total, tx_total, ts) for primary iface
    pub cpu: Option<(u64, u64)>,          // (idle_total, total_total) jiffies — aggregate
    pub cpu_per: Vec<(u64, u64)>,         // per-core (idle, total) jiffies, index = core
}

pub struct AppState {
    pub db: DbPool,
    pub events: EventChannels,
    pub config: AppConfig,
    pub http_client: reqwest::Client,
    pub admin_password_hash: String,
    pub metrics_samples: Mutex<MetricsSamples>,
}
