//! カーネルのエントロピープールへの注入。
//!
//! `ioctl(RNDADDENTROPY)` はプールにバイト列を混ぜ、同時にエントロピー推定値を
//! 加算する。加算には CAP_SYS_ADMIN が要る(単なる write ではプールに混ざるだけで
//! 推定値は増えない)。
//!
//! Linux 専用。

use anyhow::{Context, Result};
use std::fs::{File, OpenOptions};
use std::io;
use std::os::unix::io::AsRawFd;

use crate::frame::Block;

/// linux/random.h: `#define RNDADDENTROPY _IOW('R', 0x03, int[2])`
const RNDADDENTROPY: libc::c_ulong = 0x4008_5203;

pub struct KernelSink {
    device: String,
    file: File,
    bits_per_event: u32,
    pub blocks: u64,
    pub bits: u64,
}

impl KernelSink {
    pub fn open(device: &str, bits_per_event: u32) -> Result<Self> {
        let file = OpenOptions::new()
            .write(true)
            .open(device)
            .with_context(|| format!("エントロピーデバイスを開けない: {device}"))?;
        Ok(KernelSink {
            device: device.to_string(),
            file,
            bits_per_event,
            blocks: 0,
            bits: 0,
        })
    }

    /// ブロックをプールに混ぜ、エントロピー推定値を加算する。
    ///
    /// 計上は保守的に「1イベント = bits_per_event ビット」。ブロック自体が
    /// 持ちうる上限(8 * バイト数)を超えて申告はしない。
    pub fn add(&mut self, block: &Block) -> Result<()> {
        let cap_bits = (block.bytes.len() * 8) as u32;
        let credit = block.events.saturating_mul(self.bits_per_event).min(cap_bits);

        // struct rand_pool_info { int entropy_count; int buf_size; __u32 buf[]; }
        // u32 配列として組むことで 4 バイト境界を保証する。
        let mut words: Vec<u32> = Vec::with_capacity(2 + block.bytes.len().div_ceil(4));
        words.push(credit);
        words.push(block.bytes.len() as u32);
        for chunk in block.bytes.chunks(4) {
            let mut w = [0u8; 4];
            w[..chunk.len()].copy_from_slice(chunk);
            words.push(u32::from_ne_bytes(w));
        }

        let rc = unsafe { libc::ioctl(self.file.as_raw_fd(), RNDADDENTROPY, words.as_ptr()) };
        if rc < 0 {
            let err = io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::EPERM) {
                return Err(err).with_context(|| {
                    format!(
                        "{} への RNDADDENTROPY が拒否された。CAP_SYS_ADMIN が要る",
                        self.device
                    )
                });
            }
            return Err(err).with_context(|| format!("{} への RNDADDENTROPY 失敗", self.device));
        }

        self.blocks += 1;
        self.bits += credit as u64;
        Ok(())
    }

    /// カーネルが現在見積もっているプールのエントロピー量(ビット)。表示用。
    pub fn entropy_avail() -> Option<u32> {
        std::fs::read_to_string("/proc/sys/kernel/random/entropy_avail")
            .ok()?
            .trim()
            .parse()
            .ok()
    }
}
