use axum::{extract::State, routing::get, Json, Router};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Instant;

use crate::auth::AdminAuth;
use crate::error::AppError;
use crate::state::AppState;

fn proc_path(leaf: &str) -> String {
    let root = std::env::var("PROC_PATH").unwrap_or_else(|_| "/proc".to_string());
    format!("{}/{}", root, leaf)
}

async fn read_proc(leaf: &str) -> Result<String, AppError> {
    tokio::fs::read_to_string(proc_path(leaf))
        .await
        .map_err(|e| AppError::Internal(format!("read {}: {}", leaf, e)))
}

/// Returns (idle_total_jiffies, total_jiffies) from the first line of /proc/stat.
fn parse_cpu(stat: &str) -> Option<(u64, u64)> {
    let line = stat.lines().next()?;
    if !line.starts_with("cpu ") {
        return None;
    }
    let fields: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|f| f.parse().ok())
        .collect();
    if fields.len() < 5 {
        return None;
    }
    // user, nice, system, idle, iowait, irq, softirq, steal, guest, guest_nice
    let idle = fields[3] + fields.get(4).copied().unwrap_or(0);
    let total: u64 = fields.iter().sum();
    Some((idle, total))
}

fn parse_mem(meminfo: &str) -> Option<(u64, u64)> {
    let mut total_kb = None;
    let mut avail_kb = None;
    for line in meminfo.lines() {
        let (k, v) = line.split_once(':')?;
        let val = v.trim().split_whitespace().next()?.parse::<u64>().ok()?;
        match k {
            "MemTotal" => total_kb = Some(val),
            "MemAvailable" => avail_kb = Some(val),
            _ => {}
        }
        if total_kb.is_some() && avail_kb.is_some() {
            break;
        }
    }
    let total = total_kb?;
    let avail = avail_kb?;
    Some((avail.saturating_mul(1024), total.saturating_mul(1024)))
}

/// Returns (rx_total, tx_total) summed across all non-loopback interfaces.
fn parse_net(net_dev: &str) -> (u64, u64) {
    let mut rx = 0u64;
    let mut tx = 0u64;
    for line in net_dev.lines().skip(2) {
        let Some((iface, rest)) = line.split_once(':') else { continue };
        let iface = iface.trim();
        if iface == "lo" {
            continue;
        }
        let fields: Vec<u64> = rest
            .split_whitespace()
            .filter_map(|f| f.parse().ok())
            .collect();
        // rx_bytes is field 0, tx_bytes is field 8
        if fields.len() >= 9 {
            rx = rx.saturating_add(fields[0]);
            tx = tx.saturating_add(fields[8]);
        }
    }
    (rx, tx)
}

async fn get_metrics(
    _auth: AdminAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, AppError> {
    let stat = read_proc("stat").await?;
    let meminfo = read_proc("meminfo").await?;
    let net_dev = read_proc("net/dev").await?;

    let (idle_now, total_now) = parse_cpu(&stat)
        .ok_or_else(|| AppError::Internal("parse /proc/stat".into()))?;
    let (avail, total_mem) = parse_mem(&meminfo)
        .ok_or_else(|| AppError::Internal("parse /proc/meminfo".into()))?;
    let (rx_now, tx_now) = parse_net(&net_dev);
    let now = Instant::now();

    let mut samples = state.metrics_samples.lock().await;

    let cpu_pct = match samples.cpu {
        Some((idle_prev, total_prev)) if total_now > total_prev => {
            let d_total = (total_now - total_prev) as f64;
            let d_idle = idle_now.saturating_sub(idle_prev) as f64;
            (1.0 - d_idle / d_total).clamp(0.0, 1.0) * 100.0
        }
        _ => 0.0,
    };
    samples.cpu = Some((idle_now, total_now));

    let (rx_bps, tx_bps) = match samples.net {
        Some((rx_prev, tx_prev, ts_prev)) => {
            let dt = now.duration_since(ts_prev).as_secs_f64().max(0.001);
            let rx_bps = ((rx_now.saturating_sub(rx_prev)) as f64 / dt) as u64;
            let tx_bps = ((tx_now.saturating_sub(tx_prev)) as f64 / dt) as u64;
            (rx_bps, tx_bps)
        }
        None => (0, 0),
    };
    samples.net = Some((rx_now, tx_now, now));

    let used_mem = total_mem.saturating_sub(avail);
    let mem_pct = if total_mem > 0 {
        (used_mem as f64 / total_mem as f64) * 100.0
    } else {
        0.0
    };

    Ok(Json(json!({
        "cpu":     { "percent": cpu_pct },
        "memory":  { "used_bytes": used_mem, "total_bytes": total_mem, "percent": mem_pct },
        "network": { "rx_bps": rx_bps, "tx_bps": tx_bps }
    })))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/", get(get_metrics))
}
