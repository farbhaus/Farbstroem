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

type CpuJiffies = (u64, u64);

/// Parse /proc/stat: returns aggregate `(idle, total)` and a vec of per-core `(idle, total)`.
fn parse_cpu_all(stat: &str) -> Option<(CpuJiffies, Vec<CpuJiffies>)> {
    let mut agg: Option<(u64, u64)> = None;
    let mut cores: Vec<(u64, u64)> = Vec::new();
    for line in stat.lines() {
        if !line.starts_with("cpu") {
            break;
        }
        let mut it = line.split_whitespace();
        let label = it.next()?;
        let fields: Vec<u64> = it.filter_map(|f| f.parse().ok()).collect();
        if fields.len() < 5 {
            continue;
        }
        let idle = fields[3] + fields.get(4).copied().unwrap_or(0);
        let total: u64 = fields.iter().sum();
        if label == "cpu" {
            agg = Some((idle, total));
        } else {
            cores.push((idle, total));
        }
    }
    Some((agg?, cores))
}

#[derive(Default)]
struct MemInfo {
    total_bytes: u64,
    avail_bytes: u64,
    buffers_bytes: u64,
    cached_bytes: u64, // Cached + SReclaimable, matches htop
}

fn parse_mem(meminfo: &str) -> Option<MemInfo> {
    let mut total_kb: Option<u64> = None;
    let mut avail_kb: Option<u64> = None;
    let mut buffers_kb: u64 = 0;
    let mut cached_kb: u64 = 0;
    let mut sreclaim_kb: u64 = 0;
    for line in meminfo.lines() {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let Some(val) = v
            .split_whitespace()
            .next()
            .and_then(|s| s.parse::<u64>().ok())
        else {
            continue;
        };
        match k {
            "MemTotal" => total_kb = Some(val),
            "MemAvailable" => avail_kb = Some(val),
            "Buffers" => buffers_kb = val,
            "Cached" => cached_kb = val,
            "SReclaimable" => sreclaim_kb = val,
            _ => {}
        }
    }
    Some(MemInfo {
        total_bytes: total_kb?.saturating_mul(1024),
        avail_bytes: avail_kb?.saturating_mul(1024),
        buffers_bytes: buffers_kb.saturating_mul(1024),
        cached_bytes: cached_kb.saturating_add(sreclaim_kb).saturating_mul(1024),
    })
}

fn is_virtual_iface(name: &str) -> bool {
    name == "lo"
        || name.starts_with("docker")
        || name.starts_with("br-")
        || name.starts_with("veth")
        || name.starts_with("tun")
        || name.starts_with("tap")
        || name.starts_with("vboxnet")
        || name.starts_with("virbr")
        || name == "bridge0"
        // macOS virtual / utun / awdl etc.
        || name.starts_with("utun")
        || name.starts_with("awdl")
        || name.starts_with("llw")
        || name.starts_with("anpi")
        || name.starts_with("ap")
}

/// Pick a primary physical interface from /proc/net/dev. Returns
/// `(iface_name, rx_total, tx_total)`.
fn pick_primary_iface(net_dev: &str) -> Option<(String, u64, u64)> {
    let mut best: Option<(String, u64, u64, u64)> = None; // name, rx, tx, rx+tx
    for line in net_dev.lines().skip(2) {
        let Some((iface, rest)) = line.split_once(':') else {
            continue;
        };
        let iface = iface.trim();
        if is_virtual_iface(iface) {
            continue;
        }
        let fields: Vec<u64> = rest
            .split_whitespace()
            .filter_map(|f| f.parse().ok())
            .collect();
        if fields.len() < 9 {
            continue;
        }
        let rx = fields[0];
        let tx = fields[8];
        let busy = rx.saturating_add(tx);
        match &best {
            Some((_, _, _, b)) if *b >= busy => {}
            _ => best = Some((iface.to_string(), rx, tx, busy)),
        }
    }
    best.map(|(n, rx, tx, _)| (n, rx, tx))
}

fn parse_loadavg(s: &str) -> Option<(f64, f64, f64)> {
    let mut it = s.split_whitespace();
    let a: f64 = it.next()?.parse().ok()?;
    let b: f64 = it.next()?.parse().ok()?;
    let c: f64 = it.next()?.parse().ok()?;
    Some((a, b, c))
}

fn parse_uptime(s: &str) -> Option<f64> {
    s.split_whitespace().next()?.parse().ok()
}

fn pct_delta(idle_now: u64, total_now: u64, prev: Option<(u64, u64)>) -> f64 {
    match prev {
        Some((idle_prev, total_prev)) if total_now > total_prev => {
            let d_total = (total_now - total_prev) as f64;
            let d_idle = idle_now.saturating_sub(idle_prev) as f64;
            (1.0 - d_idle / d_total).clamp(0.0, 1.0) * 100.0
        }
        _ => 0.0,
    }
}

async fn get_metrics(
    _auth: AdminAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, AppError> {
    let stat = read_proc("stat").await?;
    let meminfo = read_proc("meminfo").await?;
    let net_dev = read_proc("net/dev").await?;
    let loadavg = read_proc("loadavg").await.unwrap_or_default();
    let uptime = read_proc("uptime").await.unwrap_or_default();

    let ((idle_now, total_now), cores_now) =
        parse_cpu_all(&stat).ok_or_else(|| AppError::Internal("parse /proc/stat".into()))?;
    let mem =
        parse_mem(&meminfo).ok_or_else(|| AppError::Internal("parse /proc/meminfo".into()))?;
    let primary = pick_primary_iface(&net_dev);
    let now = Instant::now();
    let load = parse_loadavg(&loadavg);
    let uptime_secs = parse_uptime(&uptime);

    let mut samples = state.metrics_samples.lock().await;

    let cpu_pct = pct_delta(idle_now, total_now, samples.cpu);
    samples.cpu = Some((idle_now, total_now));

    let cpu_cores: Vec<f64> = cores_now
        .iter()
        .enumerate()
        .map(|(i, (idle, total))| {
            let prev = samples.cpu_per.get(i).copied();
            pct_delta(*idle, *total, prev)
        })
        .collect();
    samples.cpu_per = cores_now;

    let (rx_bps, tx_bps) = match (&primary, samples.net) {
        (Some((_, rx_now, tx_now)), Some((rx_prev, tx_prev, ts_prev))) => {
            let dt = now.duration_since(ts_prev).as_secs_f64().max(0.001);
            let rx_bps = ((rx_now.saturating_sub(rx_prev)) as f64 / dt) as u64;
            let tx_bps = ((tx_now.saturating_sub(tx_prev)) as f64 / dt) as u64;
            (rx_bps, tx_bps)
        }
        _ => (0, 0),
    };
    if let Some((_, rx_now, tx_now)) = &primary {
        samples.net = Some((*rx_now, *tx_now, now));
    }

    let used_mem = mem.total_bytes.saturating_sub(mem.avail_bytes);
    let mem_pct = if mem.total_bytes > 0 {
        (used_mem as f64 / mem.total_bytes as f64) * 100.0
    } else {
        0.0
    };

    let (l1, l5, l15) = load.unwrap_or((0.0, 0.0, 0.0));

    Ok(Json(json!({
        "cpu": {
            "percent": cpu_pct,
            "cores": cpu_cores,
        },
        "memory": {
            "used_bytes":    used_mem,
            "buffers_bytes": mem.buffers_bytes,
            "cached_bytes":  mem.cached_bytes,
            "total_bytes":   mem.total_bytes,
            "percent":       mem_pct,
        },
        "network": {
            "interface": primary.as_ref().map(|(n, _, _)| n.as_str()).unwrap_or(""),
            "rx_bps":    rx_bps,
            "tx_bps":    tx_bps,
        },
        "loadavg":    [l1, l5, l15],
        "uptime_secs": uptime_secs.unwrap_or(0.0),
    })))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/", get(get_metrics))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_per_cpu() {
        let stat = "cpu  100 0 50 800 50 0 0 0 0 0\n\
                    cpu0 50 0 25 400 25 0 0 0 0 0\n\
                    cpu1 50 0 25 400 25 0 0 0 0 0\n\
                    intr 0\n";
        let ((idle, total), cores) = parse_cpu_all(stat).unwrap();
        assert_eq!(idle, 850); // 800 + 50
        assert_eq!(total, 1000);
        assert_eq!(cores.len(), 2);
        assert_eq!(cores[0], (425, 500));
    }

    #[test]
    fn parses_mem_with_cache() {
        let m = "MemTotal:       8000000 kB\n\
                 MemAvailable:   2000000 kB\n\
                 Buffers:         100000 kB\n\
                 Cached:         1500000 kB\n\
                 SReclaimable:    200000 kB\n";
        let info = parse_mem(m).unwrap();
        assert_eq!(info.total_bytes, 8_000_000 * 1024);
        assert_eq!(info.avail_bytes, 2_000_000 * 1024);
        assert_eq!(info.buffers_bytes, 100_000 * 1024);
        assert_eq!(info.cached_bytes, (1_500_000 + 200_000) * 1024);
    }

    #[test]
    fn picks_physical_iface_skipping_docker_and_veth() {
        let net = "Inter-|   Receive                                                |  Transmit\n\
                   face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n\
                   lo: 100 1 0 0 0 0 0 0  100 1 0 0 0 0 0 0\n\
                   docker0: 500 5 0 0 0 0 0 0  500 5 0 0 0 0 0 0\n\
                   veth1234: 200 2 0 0 0 0 0 0  200 2 0 0 0 0 0 0\n\
                   eth0: 9999 99 0 0 0 0 0 0  8888 88 0 0 0 0 0 0\n";
        let (iface, rx, tx) = pick_primary_iface(net).unwrap();
        assert_eq!(iface, "eth0");
        assert_eq!(rx, 9999);
        assert_eq!(tx, 8888);
    }

    #[test]
    fn picks_busiest_when_multiple_physical() {
        let net = "h1\nh2\n\
                   eth0: 10 1 0 0 0 0 0 0  10 1 0 0 0 0 0 0\n\
                   eth1: 1000 10 0 0 0 0 0 0  1000 10 0 0 0 0 0 0\n";
        let (iface, _, _) = pick_primary_iface(net).unwrap();
        assert_eq!(iface, "eth1");
    }

    #[test]
    fn parses_loadavg_and_uptime() {
        assert_eq!(
            parse_loadavg("0.10 0.20 0.30 1/100 1234"),
            Some((0.1, 0.2, 0.3))
        );
        assert_eq!(parse_uptime("12345.67 9876.54"), Some(12345.67));
    }
}
