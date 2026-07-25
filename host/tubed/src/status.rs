//! 人が読むためのステータス1行。イベント当日はこの画面を映す想定なので、
//! 増える数字と止まっている数字がひと目で分かることだけを狙う。

/// ESP32 の S 行から拾った値。取れなかった項目は None のまま出さない。
#[derive(Debug, Default, Clone)]
pub struct DeviceStats {
    pub cpm: Option<u32>,
    pub events: Option<u64>,
    pub blocks: Option<u64>,
}

impl DeviceStats {
    /// `cpm=23 events=1234 dead=5 blocks=12 queue=0B up=120s` を読む。
    pub fn update(&mut self, status_line: &str) {
        for tok in status_line.split_whitespace() {
            let Some((key, value)) = tok.split_once('=') else {
                continue;
            };
            match key {
                "cpm" => self.cpm = value.parse().ok(),
                "events" => self.events = value.parse().ok(),
                "blocks" => self.blocks = value.parse().ok(),
                _ => {}
            }
        }
    }
}

/// 表示に必要な値を呼び出し側が集めて渡す。status は各モジュールの内部を覗かない。
pub struct Snapshot {
    pub link: bool,
    pub received: u64,
    pub duplicates: u64,
    pub kernel_blocks: u64,
    pub kernel_bits: u64,
    pub entropy_avail: Option<u32>,
    pub pipe_queue: Option<usize>,
    pub pipe_full: bool,
    pub last_status: Option<u16>,
    pub last_post_secs: Option<u64>,
    pub pool_remaining: Option<u64>,
}

pub fn render(dev: &DeviceStats, snap: &Snapshot) -> String {
    let cpm = dev
        .cpm
        .map(|v| v.to_string())
        .unwrap_or_else(|| "--".into());
    let events = dev
        .events
        .map(|v| v.to_string())
        .unwrap_or_else(|| "--".into());

    let mut out = format!(
        "CPM={cpm} events={events} recv={}blk",
        snap.received
    );
    if snap.duplicates > 0 {
        out.push_str(&format!(" dup={}", snap.duplicates));
    }

    out.push_str(&format!(
        " | kernel={}blk/{}",
        snap.kernel_blocks,
        fmt_bits(snap.kernel_bits)
    ));
    if let Some(avail) = snap.entropy_avail {
        out.push_str(&format!(" avail={avail}"));
    }

    match snap.pipe_queue {
        Some(queued) => {
            out.push_str(&format!(" | kuda={queued}B"));
            match (snap.last_status, snap.last_post_secs) {
                (Some(code), Some(secs)) => {
                    out.push_str(&format!(" last_post={code}({secs}s ago)"))
                }
                (Some(code), None) => out.push_str(&format!(" last_post={code}")),
                _ => out.push_str(" last_post=--"),
            }
            if let Some(pool) = snap.pool_remaining {
                out.push_str(&format!(" pool={pool}"));
            }
            if snap.pipe_full {
                out.push_str(" [QUEUE FULL]");
            }
        }
        None => out.push_str(" | kuda=off"),
    }

    out.push_str(if snap.link { " | link=OK" } else { " | link=DOWN" });
    out
}

fn fmt_bits(bits: u64) -> String {
    if bits < 1024 {
        format!("{bits}b")
    } else if bits < 1024 * 1024 {
        format!("{:.1}Kb", bits as f64 / 1024.0)
    } else {
        format!("{:.1}Mb", bits as f64 / (1024.0 * 1024.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_device_status_line() {
        let mut dev = DeviceStats::default();
        dev.update("cpm=23 events=1234 dead=5 blocks=12 queue=96B up=120s");
        assert_eq!(dev.cpm, Some(23));
        assert_eq!(dev.events, Some(1234));
        assert_eq!(dev.blocks, Some(12));
    }

    #[test]
    fn renders_one_line() {
        let mut dev = DeviceStats::default();
        dev.update("cpm=23 events=1234 dead=0 blocks=12 queue=0B up=120s");
        let snap = Snapshot {
            link: true,
            received: 12,
            duplicates: 0,
            kernel_blocks: 6,
            kernel_bits: 1536,
            entropy_avail: Some(3891),
            pipe_queue: Some(96),
            pipe_full: false,
            last_status: Some(200),
            last_post_secs: Some(45),
            pool_remaining: Some(20034),
        };
        let line = render(&dev, &snap);
        assert_eq!(
            line,
            "CPM=23 events=1234 recv=12blk | kernel=6blk/1.5Kb avail=3891 \
             | kuda=96B last_post=200(45s ago) pool=20034 | link=OK"
        );
    }

    #[test]
    fn renders_without_pipe() {
        let dev = DeviceStats::default();
        let snap = Snapshot {
            link: false,
            received: 0,
            duplicates: 0,
            kernel_blocks: 0,
            kernel_bits: 0,
            entropy_avail: None,
            pipe_queue: None,
            pipe_full: false,
            last_status: None,
            last_post_secs: None,
            pool_remaining: None,
        };
        assert_eq!(
            render(&dev, &snap),
            "CPM=-- events=-- recv=0blk | kernel=0blk/0b | kuda=off | link=DOWN"
        );
    }
}
