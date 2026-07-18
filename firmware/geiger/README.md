# geiger firmware — 乱数の管・第二源泉 (ESP32)

CAJOE / RadiationD v1.1 系ガイガー基板のパルスから崩壊間隔を取り、SHA-256 で
白色化して kuda の `POST /ingest` に送る常駐ファーム。仕様: `docs/esp32-farm-spec.md`。

## セットアップ

```sh
cd firmware/geiger
cp include/config.example.h include/config.h   # ← config.h は gitignore
$EDITOR include/config.h                        # WiFi / PIPE_URL / INGEST_TOKEN を記入
```

PlatformIO で書き込み・監視:

```sh
pio run -t upload
pio device monitor        # 115200 baud
```

## 配線(3本)

| ガイガー基板 | ESP32 |
|---|---|
| VIN(パルス出力) | GPIO4 |
| GND | GND |
| 5V | 5V(VUSB) |

パルスは3V負論理なのでレベル変換不要。オンボードLED(GPIO2)が検出時に短く点滅。

## まず TEST_MODE で疎通

ガイガー基板が無くても、`config.h` の `TEST_MODE 1` にすれば擬似ポアソン過程
(平均25CPM)で全経路(WiFi→白色化→`/ingest`)を検証できる。`source="test"` で
送るので本番の `geiger` 粒と混ざらない。`/status` の `pool_remaining` が増えれば成功。

本番投入時は `TEST_MODE 0` に戻すこと。

## 処理の要点(規律)

- 疑似乱数で埋めない。溜まった分だけ送る。
- `POST /ingest` が **200 のときだけ**送信キューをクリア(二重投入しない)。
- 送信失敗は指数バックオフ(30s→60s→…→上限10分)。
- 送信キューが 4KiB に達したら**新規蓄積を停止**して警告(古い粒の破棄も上書きもしない)。
- `INGEST_TOKEN` はシリアルに出さない。

## シリアル出力(115200)

10秒ごとに1行:

```
CPM=23 events_total=1234 queue=96B wifi=OK last_post=200(45s ago)
```

起動時に WiFi 接続結果と kuda `GET /status` の疎通を表示。当日はこの画面を
プロジェクタに映す想定。

## ビルド確認について

このファームは ESP32 実機/PlatformIO 環境でのビルド・書き込みが前提。
CI(この Worker リポジトリの Cloudflare Workers Builds)ではビルドしない。
7/25 前に一度、実機 or PlatformIO でビルドが通ることを確認しておくこと。
