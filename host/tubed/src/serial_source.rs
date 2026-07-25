//! シリアルからの行読み取りと、ブロックの重複排除。
//!
//! ESP32 は抜き差しされるし、tubed より先に電源が入ることもある。ポートが
//! 無ければ黙って待ち、現れたら開き直す。読めた行はそのまま上位に渡す
//! (解釈は frame.rs の責務)。

use std::collections::{HashSet, VecDeque};
use std::io::{ErrorKind, Read};
use std::time::{Duration, Instant};

const READ_TIMEOUT: Duration = Duration::from_millis(200);
const REOPEN_INTERVAL: Duration = Duration::from_secs(2);
/// 1行の上限。これを超えたら同期ずれとみなして捨てる。
const MAX_PENDING: usize = 4096;

pub struct SerialSource {
    device: String,
    baud: u32,
    port: Option<Box<dyn serialport::SerialPort>>,
    pending: Vec<u8>,
    next_open: Instant,
    /// 直近の接続失敗理由。状態が変わったときだけ表示するために持つ。
    pub last_error: Option<String>,
}

impl SerialSource {
    pub fn new(device: &str, baud: u32) -> Self {
        SerialSource {
            device: device.to_string(),
            baud,
            port: None,
            pending: Vec::new(),
            next_open: Instant::now(),
            last_error: None,
        }
    }

    pub fn is_connected(&self) -> bool {
        self.port.is_some()
    }

    pub fn device(&self) -> &str {
        &self.device
    }

    /// 読めた行を返す。接続が無ければ空を返して次の再オープンを待つ。
    pub fn poll(&mut self) -> Vec<String> {
        if self.port.is_none() && !self.try_open() {
            return Vec::new();
        }

        let mut chunk = [0u8; 1024];
        let read = {
            let port = self.port.as_mut().expect("port は開いている");
            port.read(&mut chunk)
        };

        match read {
            Ok(0) => Vec::new(),
            Ok(n) => {
                self.pending.extend_from_slice(&chunk[..n]);
                self.extract_lines()
            }
            Err(e) if e.kind() == ErrorKind::TimedOut => Vec::new(),
            Err(e) => {
                self.port = None;
                self.pending.clear();
                self.last_error = Some(e.to_string());
                self.next_open = Instant::now() + REOPEN_INTERVAL;
                Vec::new()
            }
        }
    }

    fn try_open(&mut self) -> bool {
        if Instant::now() < self.next_open {
            return false;
        }
        self.next_open = Instant::now() + REOPEN_INTERVAL;
        match serialport::new(&self.device, self.baud)
            .timeout(READ_TIMEOUT)
            .open()
        {
            Ok(port) => {
                self.port = Some(port);
                self.last_error = None;
                true
            }
            Err(e) => {
                self.last_error = Some(e.to_string());
                false
            }
        }
    }

    fn extract_lines(&mut self) -> Vec<String> {
        let mut lines = Vec::new();
        while let Some(pos) = self.pending.iter().position(|b| *b == b'\n') {
            let raw: Vec<u8> = self.pending.drain(..=pos).collect();
            let text = String::from_utf8_lossy(&raw).trim().to_string();
            if !text.is_empty() {
                lines.push(text);
            }
        }
        // 改行が来ないまま膨らんだら同期ずれ。溜め込まずに捨てる。
        if self.pending.len() > MAX_PENDING {
            self.pending.clear();
        }
        lines
    }
}

/// (boot_id, seq) による重複排除。ESP32 が再起動すると boot_id が変わるので、
/// seq が 0 に戻っても以前のブロックと衝突しない。
pub struct Dedup {
    set: HashSet<(u32, u32)>,
    order: VecDeque<(u32, u32)>,
    cap: usize,
}

impl Dedup {
    pub fn new(cap: usize) -> Self {
        Dedup {
            set: HashSet::new(),
            order: VecDeque::new(),
            cap,
        }
    }

    /// 初めて見るキーなら true を返して記憶する。
    pub fn accept(&mut self, key: (u32, u32)) -> bool {
        if !self.set.insert(key) {
            return false;
        }
        self.order.push_back(key);
        if self.order.len() > self.cap {
            if let Some(old) = self.order.pop_front() {
                self.set.remove(&old);
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedup_rejects_repeats() {
        let mut d = Dedup::new(4);
        assert!(d.accept((1, 0)));
        assert!(!d.accept((1, 0)));
        assert!(d.accept((1, 1)));
    }

    #[test]
    fn dedup_separates_boots() {
        let mut d = Dedup::new(4);
        assert!(d.accept((1, 0)));
        // 再起動して boot_id が変われば seq 0 は別物
        assert!(d.accept((2, 0)));
    }

    #[test]
    fn dedup_forgets_oldest_beyond_cap() {
        let mut d = Dedup::new(2);
        d.accept((1, 0));
        d.accept((1, 1));
        d.accept((1, 2)); // (1,0) が押し出される
        assert!(d.accept((1, 0)));
    }
}
