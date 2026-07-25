//! ESP32 が吐く行指向プロトコルのパーサ。
//!
//! ```text
//! V tubelet <fw> boot=<hex8> mode=<geiger|test> whiten=<n> gpio=<n>
//! E <boot_id hex8> <seq> <events> <geiger|test> <base64 32B>
//! S cpm=23 events=1234 dead=5 blocks=12 queue=96B up=120s
//! W <message>
//! ```
//!
//! ブートローダの ROM メッセージなど素性の知れない行が混ざるため、
//! 認識できない行は Ok(None) として静かに捨てる。E/V 行として始まったのに
//! 壊れている場合だけエラーにする(配線やボーレートの異常を見逃さないため)。

use anyhow::{anyhow, bail, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;

/// SHA-256 の出力サイズ。ファーム側と合わせる。
pub const BLOCK_BYTES: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Geiger,
    Test,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Geiger => "geiger",
            Source::Test => "test",
        }
    }

    fn parse(s: &str) -> Result<Source> {
        match s {
            "geiger" => Ok(Source::Geiger),
            "test" => Ok(Source::Test),
            other => Err(anyhow!("未知の source: {other}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    pub boot_id: u32,
    pub seq: u32,
    /// このブロックに寄与した崩壊イベント数。エントロピー計上の根拠。
    pub events: u32,
    pub source: Source,
    pub bytes: Vec<u8>,
}

impl Block {
    /// 重複排除のキー。ESP32 が再起動すると boot_id が変わり seq は 0 に戻る。
    pub fn key(&self) -> (u32, u32) {
        (self.boot_id, self.seq)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub fw: String,
    pub boot_id: u32,
    pub mode: Source,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Version(Version),
    Entropy(Block),
    Status(String),
    Warn(String),
}

pub fn parse_line(line: &str) -> Result<Option<Frame>> {
    let line = line.trim();
    let (tag, rest) = match line.split_once(' ') {
        Some(pair) => pair,
        None => return Ok(None),
    };

    match tag {
        "E" => Ok(Some(Frame::Entropy(parse_entropy(rest)?))),
        "V" => Ok(Some(Frame::Version(parse_version(rest)?))),
        "S" => Ok(Some(Frame::Status(rest.to_string()))),
        "W" => Ok(Some(Frame::Warn(rest.to_string()))),
        _ => Ok(None),
    }
}

fn parse_entropy(rest: &str) -> Result<Block> {
    let mut it = rest.split_whitespace();
    let boot_id = it.next().ok_or_else(|| anyhow!("E 行に boot_id が無い"))?;
    let seq = it.next().ok_or_else(|| anyhow!("E 行に seq が無い"))?;
    let events = it.next().ok_or_else(|| anyhow!("E 行に events が無い"))?;
    let source = it.next().ok_or_else(|| anyhow!("E 行に source が無い"))?;
    let payload = it.next().ok_or_else(|| anyhow!("E 行に本体が無い"))?;
    if it.next().is_some() {
        bail!("E 行の項目が多い");
    }

    let boot_id = u32::from_str_radix(boot_id, 16)
        .map_err(|e| anyhow!("boot_id が16進数でない: {boot_id} ({e})"))?;
    let seq: u32 = seq.parse().map_err(|e| anyhow!("seq が数値でない: {seq} ({e})"))?;
    let events: u32 = events
        .parse()
        .map_err(|e| anyhow!("events が数値でない: {events} ({e})"))?;
    if events == 0 {
        bail!("events が 0 のブロックは受け取らない");
    }
    let source = Source::parse(source)?;

    let bytes = BASE64
        .decode(payload)
        .map_err(|e| anyhow!("base64 デコード失敗: {e}"))?;
    if bytes.len() != BLOCK_BYTES {
        bail!("ブロック長が {} バイトでない: {}", BLOCK_BYTES, bytes.len());
    }

    Ok(Block {
        boot_id,
        seq,
        events,
        source,
        bytes,
    })
}

fn parse_version(rest: &str) -> Result<Version> {
    let mut fw = String::new();
    let mut boot_id = None;
    let mut mode = None;

    for (i, tok) in rest.split_whitespace().enumerate() {
        if let Some(v) = tok.strip_prefix("boot=") {
            boot_id = Some(
                u32::from_str_radix(v, 16).map_err(|e| anyhow!("V 行の boot が16進数でない: {e}"))?,
            );
        } else if let Some(v) = tok.strip_prefix("mode=") {
            mode = Some(Source::parse(v)?);
        } else if i == 1 {
            fw = tok.to_string();
        }
    }

    Ok(Version {
        fw,
        boot_id: boot_id.ok_or_else(|| anyhow!("V 行に boot= が無い"))?,
        mode: mode.ok_or_else(|| anyhow!("V 行に mode= が無い"))?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str =
        "E b5f976ff 3 256 test cMZYjmfsqOhguHmHLce2Jq2sWJJqHg+bHCEZig+hP7M=";

    #[test]
    fn parses_entropy_line() {
        let frame = parse_line(SAMPLE).unwrap().unwrap();
        let Frame::Entropy(block) = frame else {
            panic!("E 行が Entropy にならない");
        };
        assert_eq!(block.boot_id, 0xb5f976ff);
        assert_eq!(block.seq, 3);
        assert_eq!(block.events, 256);
        assert_eq!(block.source, Source::Test);
        assert_eq!(block.bytes.len(), BLOCK_BYTES);
        assert_eq!(block.key(), (0xb5f976ff, 3));
    }

    #[test]
    fn parses_version_line() {
        let frame = parse_line("V tubelet usb-0.1.0 boot=b5f976ff mode=geiger whiten=256 gpio=4")
            .unwrap()
            .unwrap();
        assert_eq!(
            frame,
            Frame::Version(Version {
                fw: "usb-0.1.0".to_string(),
                boot_id: 0xb5f976ff,
                mode: Source::Geiger,
            })
        );
    }

    #[test]
    fn parses_status_and_warn() {
        let s = parse_line("S cpm=23 events=1234 dead=5 blocks=12 queue=96B up=120s")
            .unwrap()
            .unwrap();
        assert!(matches!(s, Frame::Status(_)));
        let w = parse_line("W block queue full (4KiB)").unwrap().unwrap();
        assert_eq!(w, Frame::Warn("block queue full (4KiB)".to_string()));
    }

    #[test]
    fn ignores_bootloader_noise() {
        // ブートローダの ROM メッセージや化けた行は黙って捨てる
        assert!(parse_line("rst:0x1 (POWERON_RESET),boot:0x13").unwrap().is_none());
        assert!(parse_line("load:0x40078000,len:13232").unwrap().is_none());
        assert!(parse_line("").unwrap().is_none());
        assert!(parse_line("E").unwrap().is_none()); // 区切りが無い行はタグとみなさない
    }

    #[test]
    fn rejects_unknown_source() {
        let line = SAMPLE.replace(" test ", " home ");
        assert!(parse_line(&line).is_err());
    }

    #[test]
    fn rejects_wrong_block_length() {
        let short = BASE64.encode([0u8; 16]);
        let line = format!("E b5f976ff 3 256 test {short}");
        assert!(parse_line(&line).is_err());
    }

    #[test]
    fn rejects_broken_base64() {
        let line = "E b5f976ff 3 256 test !!!not-base64!!!";
        assert!(parse_line(line).is_err());
    }

    #[test]
    fn rejects_zero_events() {
        let line = SAMPLE.replace(" 256 ", " 0 ");
        assert!(parse_line(&line).is_err());
    }
}
