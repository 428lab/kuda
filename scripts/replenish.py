#!/usr/bin/env python3
"""乱数の管 — 自宅側の補充スクリプト。

物理源からバイト列を読み、Workerの /ingest にPOSTする。
cronやsystemd timerで回すか、/status の pool_remaining を見て
閾値を切ったら補充する運用を想定。

環境変数:
  PIPE_URL      例: https://kuda.<subdomain>.workers.dev
  INGEST_TOKEN  wranglerに入れたものと同じ値
  SOURCE        hwrng | serial | urandom  (default: hwrng)
  N_BYTES       1回の補充量 (default: 256)
  SERIAL_PORT   SOURCE=serial のとき。例: /dev/ttyUSB0

注意: urandom はCSPRNGであって物理ゆらぎではない。動作確認用の
プレースホルダ。本番はESP32(ツェナー/ガイガー)なりhwrngなりに差し替えること。
"""

import base64
import json
import os
import sys
import urllib.request

PIPE_URL = os.environ.get("PIPE_URL", "").rstrip("/")
INGEST_TOKEN = os.environ.get("INGEST_TOKEN", "")
SOURCE = os.environ.get("SOURCE", "hwrng")
N_BYTES = int(os.environ.get("N_BYTES", "256"))


def read_entropy(n: int) -> bytes:
    if SOURCE == "hwrng":
        # カーネルが認識するHW乱数源 (TPM, RPiのbcm2835-rng等)
        with open("/dev/hwrng", "rb") as f:
            return f.read(n)
    elif SOURCE == "serial":
        # ESP32等がrawバイトを垂れ流すシリアルポートから読む
        import serial  # pip install pyserial
        port = os.environ.get("SERIAL_PORT", "/dev/ttyUSB0")
        with serial.Serial(port, 115200, timeout=10) as s:
            buf = s.read(n)
            if len(buf) < n:
                raise RuntimeError(f"serial short read: {len(buf)}/{n}")
            return buf
    elif SOURCE == "urandom":
        # ※物理ゆらぎではない。配管の動作確認専用
        return os.urandom(n)
    else:
        raise ValueError(f"unknown SOURCE: {SOURCE}")


def main() -> int:
    if not PIPE_URL or not INGEST_TOKEN:
        print("PIPE_URL / INGEST_TOKEN を設定してください", file=sys.stderr)
        return 1

    raw = read_entropy(N_BYTES)
    payload = json.dumps({"bytes": base64.b64encode(raw).decode()}).encode()

    req = urllib.request.Request(
        f"{PIPE_URL}/ingest",
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {INGEST_TOKEN}",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        body = json.loads(res.read())
        print(f"ingested={body.get('ingested')} "
              f"pool_remaining={body.get('pool_remaining')} "
              f"batch={body.get('batch')} (source={SOURCE})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
