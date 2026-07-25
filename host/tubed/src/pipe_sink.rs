//! kuda への補充 (POST /ingest)。
//!
//! 規律:
//! - 200 が返ったときだけキューをクリアする(再送で二重投入しない)。
//! - キューが上限に達したら新規蓄積を停止して警告。古い粒の破棄も上書きもしない。
//! - 出自の異なる粒(geiger / test)は別のキューに積み、1回の POST に混ぜない。

use anyhow::{Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Deserialize;
use std::time::{Duration, Instant};

use crate::config::Pipe as PipeConfig;
use crate::frame::{Block, Source};

#[derive(Deserialize)]
struct IngestResponse {
    pool_remaining: Option<u64>,
}

#[derive(Deserialize)]
struct StatusResponse {
    pool_remaining: Option<u64>,
    version: Option<String>,
}

/// push の結果。満杯に落ちた最初の1回だけ警告を出すため first を返す。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Push {
    Accepted,
    Rejected { first: bool },
}

struct Queue {
    source: Source,
    bytes: Vec<u8>,
    full: bool,
    last_post: Instant,
}

impl Queue {
    fn new(source: Source) -> Self {
        Queue {
            source,
            bytes: Vec::new(),
            full: false,
            last_post: Instant::now(),
        }
    }
}

pub struct PipeSink {
    cfg: PipeConfig,
    client: reqwest::blocking::Client,
    queues: [Queue; 2],
    backoff: Duration,
    next_attempt: Instant,
    pub last_status: Option<u16>,
    pub last_post: Option<Instant>,
    pub pool_remaining: Option<u64>,
    pub bytes_sent: u64,
}

fn slot(source: Source) -> usize {
    match source {
        Source::Geiger => 0,
        Source::Test => 1,
    }
}

impl PipeSink {
    pub fn new(cfg: PipeConfig) -> Result<Self> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(cfg.timeout_secs))
            .build()
            .context("HTTP クライアントを作れない")?;
        let backoff = Duration::from_secs(cfg.backoff_min_secs);
        Ok(PipeSink {
            cfg,
            client,
            queues: [Queue::new(Source::Geiger), Queue::new(Source::Test)],
            backoff,
            next_attempt: Instant::now(),
            last_status: None,
            last_post: None,
            pool_remaining: None,
            bytes_sent: 0,
        })
    }

    /// 起動時の疎通確認 (GET /status)。消費はしない。
    pub fn check(&mut self) -> Result<String> {
        let url = format!("{}/status", self.cfg.url);
        let resp = self.client.get(&url).send().context("kuda に届かない")?;
        let code = resp.status().as_u16();
        if code != 200 {
            anyhow::bail!("kuda /status -> {code}");
        }
        let body: StatusResponse = resp.json().context("/status の JSON を解釈できない")?;
        self.pool_remaining = body.pool_remaining;
        Ok(format!(
            "pool_remaining={} version={}",
            body.pool_remaining
                .map(|v| v.to_string())
                .unwrap_or_else(|| "?".into()),
            body.version.unwrap_or_else(|| "?".into())
        ))
    }

    pub fn queued_bytes(&self) -> usize {
        self.queues.iter().map(|q| q.bytes.len()).sum()
    }

    pub fn is_full(&self) -> bool {
        self.queues.iter().any(|q| q.full)
    }

    /// キューに積む。満杯なら受け取らない(古い粒の破棄も上書きもしない)。
    pub fn push(&mut self, block: &Block) -> Push {
        let q = &mut self.queues[slot(block.source)];
        if q.bytes.len() + block.bytes.len() > self.cfg.queue_max_bytes {
            let first = !q.full;
            q.full = true;
            return Push::Rejected { first };
        }
        q.bytes.extend_from_slice(&block.bytes);
        Push::Accepted
    }

    fn should_send(&self, q: &Queue) -> bool {
        if q.bytes.is_empty() {
            return false;
        }
        if q.bytes.len() >= self.cfg.send_threshold {
            return true;
        }
        q.bytes.len() >= self.cfg.send_min
            && q.last_post.elapsed() >= Duration::from_secs(self.cfg.idle_secs)
    }

    /// 送信条件を満たすキューがあれば送る。戻り値は「送信を試みたか」。
    pub fn tick(&mut self) -> Vec<String> {
        let mut notes = Vec::new();
        if Instant::now() < self.next_attempt {
            return notes;
        }
        for i in 0..self.queues.len() {
            if !self.should_send(&self.queues[i]) {
                continue;
            }
            match self.post(i) {
                Ok(()) => {}
                Err(e) => {
                    notes.push(format!(
                        "送信失敗 ({e:#}) — {}秒後に再試行",
                        self.backoff.as_secs()
                    ));
                    self.next_attempt = Instant::now() + self.backoff;
                    let doubled = self.backoff.saturating_mul(2);
                    let max = Duration::from_secs(self.cfg.backoff_max_secs);
                    self.backoff = if doubled > max { max } else { doubled };
                    break; // ネットワークが死んでいるなら他のキューも試さない
                }
            }
        }
        notes
    }

    fn post(&mut self, index: usize) -> Result<()> {
        let payload = BASE64.encode(&self.queues[index].bytes);
        let source = self.queues[index].source.as_str();
        let url = format!("{}/ingest", self.cfg.url);

        let resp = self
            .client
            .post(&url)
            .bearer_auth(&self.cfg.token)
            .json(&serde_json::json!({ "bytes": payload, "source": source }))
            .send()
            .context("POST /ingest に失敗")?;

        let code = resp.status().as_u16();
        self.last_status = Some(code);
        if code != 200 {
            anyhow::bail!("/ingest -> {code}");
        }

        let sent = self.queues[index].bytes.len();
        // 200 を確認してからクリアする。ここより前でクリアしてはならない。
        let q = &mut self.queues[index];
        q.bytes.clear();
        q.full = false;
        q.last_post = Instant::now();

        self.bytes_sent += sent as u64;
        self.last_post = Some(Instant::now());
        self.backoff = Duration::from_secs(self.cfg.backoff_min_secs);
        self.next_attempt = Instant::now();

        if let Ok(body) = resp.json::<IngestResponse>() {
            if body.pool_remaining.is_some() {
                self.pool_remaining = body.pool_remaining;
            }
        }
        Ok(())
    }
}
