# geiger firmware — 乱数の管・第二源泉 (ESP32・USB版)

CAJOE / RadiationD v1.1 系ガイガー基板のパルスから崩壊間隔を取り、SHA-256 で
白色化して **USB シリアルに吐く**常駐ファーム。粒の行き先はホスト側の
[`tubed`](../../host/tubed) が決める。仕様: `docs/esp32-farm-spec.md`。

このファームは WiFi にも kuda にも触らない。**秘密情報を一切持たない**ので、
ファームやシリアルログからトークンが漏れる経路が構造的に存在しない。

## セットアップ

```sh
cd firmware/geiger
cp include/config.example.h include/config.h   # ← config.h は gitignore
$EDITOR include/config.h                        # ピン・閾値・TEST_MODE を調整
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
給電はホスト(Ubuntu)の USB ポートから。

## シリアル出力(115200 8N1)

```
V tubelet usb-0.1.0 boot=b5f976ff mode=geiger whiten=256 gpio=4
E b5f976ff 0 256 geiger YgrTe0gMJF2RDyMvUvUflM7II7TNIb4hXR2W5kechAc=
S cpm=23 events=1234 dead=5 blocks=12 queue=0B up=120s
W block queue full (4KiB) - 新規蓄積を停止。ホストの受信待ち
```

- `E` = 32バイトのエントロピーブロック。`boot_id` と `seq` が付くので、
  ホストは再起動と再送を区別して重複を排除できる。
- `S` = 10秒ごとのステータス。
- ホストが読むのは `E` 行だけ。`V`/`S`/`W` は人間向け。

## まず TEST_MODE で疎通

ガイガー基板が無くても、`config.h` の `TEST_MODE 1` にすれば擬似ポアソン過程で
全経路(白色化→シリアル→tubed→kuda / `/dev/random`)を検証できる。出自が
`test` になるので本番の `geiger` 粒と混ざらない。

25CPM だと 512 イベント溜まるのに約20分かかる。配線確認を急ぐときは
`TEST_CPM` を一時的に上げる(例: 6000 なら数秒で1ブロック)。

本番投入時は `TEST_MODE 0` に戻すこと。

## 処理の要点(規律)

- 疑似乱数で埋めない。溜まった分だけ出す。
- 全ブロックに `(boot_id, seq)` が付く(二重投入をホスト側で防げる)。
- 未送出キューが 4KiB に達したら**新規蓄積を停止**して警告(古い粒の破棄も
  上書きもしない)。

## ビルド確認について

このファームは ESP32 実機/PlatformIO 環境でのビルド・書き込みが前提。
CI(この Worker リポジトリの Cloudflare Workers Builds)ではビルドしない。
