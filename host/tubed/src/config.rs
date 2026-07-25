//! 設定の読み込み。実値は /etc/tubed/config.toml に置き、リポジトリには
//! config.example.toml だけを置く。INGEST_TOKEN は Debug 出力にも載せない。

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::fmt;
use std::path::Path;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    pub serial: Serial,
    #[serde(default)]
    pub split: Split,
    #[serde(default)]
    pub kernel: Kernel,
    pub pipe: Option<Pipe>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Serial {
    #[serde(default = "default_device")]
    pub device: String,
    #[serde(default = "default_baud")]
    pub baud: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Split {
    /// 0.0..=1.0。ブロック単位で kernel に回す割合。残りが kuda に行く。
    /// 同じブロックが両方に流れることはない。
    #[serde(default = "default_kernel_share")]
    pub kernel_share: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Kernel {
    /// RNDADDENTROPY を発行する対象。/dev/urandom と /dev/random は同じプールを指す。
    #[serde(default = "default_kernel_device")]
    pub device: String,
    /// 1イベントあたり何ビットとして計上するか。保守的に 1。
    #[serde(default = "default_bits_per_event")]
    pub bits_per_event: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pipe {
    /// 末尾スラッシュなし。例: https://kuda.kojiran.workers.dev
    pub url: String,
    /// Worker の Secret と同じ値。ログには絶対に出さない。
    pub token: String,
    #[serde(default = "default_queue_max")]
    pub queue_max_bytes: usize,
    #[serde(default = "default_send_threshold")]
    pub send_threshold: usize,
    #[serde(default = "default_send_min")]
    pub send_min: usize,
    #[serde(default = "default_idle_secs")]
    pub idle_secs: u64,
    #[serde(default = "default_backoff_min")]
    pub backoff_min_secs: u64,
    #[serde(default = "default_backoff_max")]
    pub backoff_max_secs: u64,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
}

fn default_device() -> String {
    "/dev/tubelet".to_string()
}
fn default_baud() -> u32 {
    115200
}
fn default_kernel_share() -> f64 {
    0.5
}
fn default_kernel_device() -> String {
    "/dev/urandom".to_string()
}
fn default_bits_per_event() -> u32 {
    1
}
fn default_queue_max() -> usize {
    4096
}
fn default_send_threshold() -> usize {
    64
}
fn default_send_min() -> usize {
    32
}
fn default_idle_secs() -> u64 {
    600
}
fn default_backoff_min() -> u64 {
    30
}
fn default_backoff_max() -> u64 {
    600
}
fn default_timeout() -> u64 {
    20
}

impl Default for Serial {
    fn default() -> Self {
        Serial {
            device: default_device(),
            baud: default_baud(),
        }
    }
}

impl Default for Split {
    fn default() -> Self {
        Split {
            kernel_share: default_kernel_share(),
        }
    }
}

impl Default for Kernel {
    fn default() -> Self {
        Kernel {
            device: default_kernel_device(),
            bits_per_event: default_bits_per_event(),
        }
    }
}

// token が Debug 出力に混ざらないよう手で書く。derive すると事故る。
impl fmt::Debug for Pipe {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Pipe")
            .field("url", &self.url)
            .field("token", &"***")
            .field("queue_max_bytes", &self.queue_max_bytes)
            .field("send_threshold", &self.send_threshold)
            .field("send_min", &self.send_min)
            .field("idle_secs", &self.idle_secs)
            .field("backoff_min_secs", &self.backoff_min_secs)
            .field("backoff_max_secs", &self.backoff_max_secs)
            .field("timeout_secs", &self.timeout_secs)
            .finish()
    }
}

impl Config {
    pub fn load(path: &Path) -> Result<Config> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("設定ファイルを読めない: {}", path.display()))?;
        let cfg: Config = toml::from_str(&text)
            .with_context(|| format!("設定ファイルの構文エラー: {}", path.display()))?;
        cfg.validate()?;
        Ok(cfg)
    }

    fn validate(&self) -> Result<()> {
        let share = self.split.kernel_share;
        if !(0.0..=1.0).contains(&share) {
            bail!("split.kernel_share は 0.0..=1.0 の範囲で指定する (指定値: {share})");
        }
        if share < 1.0 && self.pipe.is_none() {
            bail!(
                "kernel_share={share} なので kuda に回る分があるが [pipe] が無い。\
                 [pipe] を書くか kernel_share = 1.0 にすること"
            );
        }
        if let Some(pipe) = &self.pipe {
            if pipe.url.ends_with('/') {
                bail!("pipe.url は末尾スラッシュなしで指定する: {}", pipe.url);
            }
            if pipe.token.is_empty() {
                bail!("pipe.token が空");
            }
            if pipe.send_min == 0 || pipe.send_threshold == 0 {
                bail!("pipe.send_min / pipe.send_threshold は 1 以上");
            }
            if pipe.queue_max_bytes < pipe.send_threshold {
                bail!("pipe.queue_max_bytes が send_threshold より小さい");
            }
            // kuda の /ingest は1回 64KiB まで。キューがそれを超えると送れなくなる。
            if pipe.queue_max_bytes > 65536 {
                bail!("pipe.queue_max_bytes は 65536 (kuda /ingest の上限) 以下にする");
            }
            if pipe.backoff_min_secs == 0 || pipe.backoff_max_secs < pipe.backoff_min_secs {
                bail!("pipe.backoff_min_secs / backoff_max_secs の関係が不正");
            }
        }
        if self.kernel.bits_per_event == 0 || self.kernel.bits_per_event > 8 {
            bail!("kernel.bits_per_event は 1..=8 (保守的な既定値は 1)");
        }
        Ok(())
    }
}
