//! tubed — ガイガー管由来のエントロピーを /dev/random と kuda に配る常駐デーモン。
//!
//! ESP32(tubelet)が USB シリアルに吐く 32B ブロックを読み、config の kernel_share に
//! 従ってどちらか一方の宛先へ渡す。同じブロックが両方に行くことはない。
//!
//! 仕様: docs/tubed-spec.md

mod config;
mod frame;
mod kernel_sink;
mod pipe_sink;
mod router;
mod serial_source;
mod status;

use anyhow::{bail, Result};
use std::path::Path;
use std::time::{Duration, Instant};

use config::Config;
use frame::Frame;
use kernel_sink::KernelSink;
use pipe_sink::{PipeSink, Push};
use router::{Destination, Router};
use serial_source::{Dedup, SerialSource};
use status::{DeviceStats, Snapshot};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_CONFIG: &str = "/etc/tubed/config.toml";
const STATUS_INTERVAL: Duration = Duration::from_secs(10);
const DEDUP_CAPACITY: usize = 4096;
const POLL_IDLE: Duration = Duration::from_millis(50);

fn main() -> Result<()> {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| DEFAULT_CONFIG.to_string());
    let cfg = Config::load(Path::new(&path))?;

    println!("=== 乱数の管 tubed {VERSION} ===");
    println!("設定: {path}");
    let share = cfg.split.kernel_share;
    println!(
        "配分: /dev/random {:.0}% / kuda {:.0}%",
        share * 100.0,
        (1.0 - share) * 100.0
    );

    run(cfg)
}

fn run(cfg: Config) -> Result<()> {
    let mut kernel = if cfg.split.kernel_share > 0.0 {
        let sink = KernelSink::open(&cfg.kernel.device, cfg.kernel.bits_per_event)?;
        println!(
            "カーネル: {} (1イベント={}bit で計上)",
            cfg.kernel.device, cfg.kernel.bits_per_event
        );
        Some(sink)
    } else {
        None
    };

    let mut pipe = match cfg.pipe {
        Some(pipe_cfg) if cfg.split.kernel_share < 1.0 => {
            let url = pipe_cfg.url.clone();
            let mut sink = PipeSink::new(pipe_cfg)?;
            // 疎通しなくても起動する。粒は溜めておいて復帰後に送る。
            match sink.check() {
                Ok(info) => println!("kuda: {url} 疎通OK {info}"),
                Err(e) => println!("kuda: {url} に届かない ({e:#}) — 蓄積して復帰を待つ"),
            }
            Some(sink)
        }
        _ => None,
    };

    let mut source = SerialSource::new(&cfg.serial.device, cfg.serial.baud);
    println!("シリアル: {} {}bps", cfg.serial.device, cfg.serial.baud);

    let mut dedup = Dedup::new(DEDUP_CAPACITY);
    let mut router = Router::new(cfg.split.kernel_share);
    let mut dev = DeviceStats::default();
    let mut received: u64 = 0;
    let mut duplicates: u64 = 0;
    let mut connected = false;
    let mut last_status_at = Instant::now();

    loop {
        let lines = source.poll();

        if source.is_connected() != connected {
            connected = source.is_connected();
            if connected {
                println!("シリアル接続: {}", source.device());
            } else {
                println!(
                    "シリアル切断: {} ({})",
                    source.device(),
                    source.last_error.as_deref().unwrap_or("理由不明")
                );
            }
        }

        for line in lines {
            match frame::parse_line(&line) {
                Ok(Some(Frame::Entropy(block))) => {
                    if !dedup.accept(block.key()) {
                        duplicates += 1;
                        continue;
                    }
                    received += 1;
                    match (router.route(), kernel.as_mut(), pipe.as_mut()) {
                        (Destination::Kernel, Some(k), _) => {
                            if let Err(e) = k.add(&block) {
                                eprintln!("カーネルへの注入に失敗: {e:#}");
                            }
                        }
                        (Destination::Pipe, _, Some(p)) => {
                            if let Push::Rejected { first: true } = p.push(&block) {
                                eprintln!(
                                    "kuda 送信キューが満杯 — 新規蓄積を停止。復帰を待つ"
                                );
                            }
                        }
                        // config の検証を通っていれば宛先は必ず存在する。
                        _ => bail!("設定の不整合: 宛先のない粒が発生した"),
                    }
                }
                Ok(Some(Frame::Version(v))) => {
                    println!(
                        "tubelet 起動: fw={} boot={:08x} mode={}",
                        v.fw,
                        v.boot_id,
                        v.mode.as_str()
                    );
                }
                Ok(Some(Frame::Status(s))) => dev.update(&s),
                Ok(Some(Frame::Warn(w))) => println!("[tubelet] {w}"),
                Ok(None) => {}
                Err(e) => eprintln!("解釈できない行: {e:#}"),
            }
        }

        if let Some(p) = pipe.as_mut() {
            for note in p.tick() {
                println!("kuda: {note}");
            }
        }

        if last_status_at.elapsed() >= STATUS_INTERVAL {
            last_status_at = Instant::now();
            let snap = Snapshot {
                link: connected,
                received,
                duplicates,
                kernel_blocks: kernel.as_ref().map(|k| k.blocks).unwrap_or(0),
                kernel_bits: kernel.as_ref().map(|k| k.bits).unwrap_or(0),
                entropy_avail: KernelSink::entropy_avail(),
                pipe_queue: pipe.as_ref().map(|p| p.queued_bytes()),
                pipe_full: pipe.as_ref().map(|p| p.is_full()).unwrap_or(false),
                last_status: pipe.as_ref().and_then(|p| p.last_status),
                last_post_secs: pipe
                    .as_ref()
                    .and_then(|p| p.last_post)
                    .map(|t| t.elapsed().as_secs()),
                pool_remaining: pipe.as_ref().and_then(|p| p.pool_remaining),
            };
            println!("{}", status::render(&dev, &snap));
        }

        std::thread::sleep(POLL_IDLE);
    }
}
