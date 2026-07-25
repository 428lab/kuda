# tubed — 物理エントロピーの配管

USB で刺さった tubelet(ガイガー基板 + ESP32)が吐く 32B ブロックを読み、
カーネルのエントロピープールと kuda に配る常駐デーモン。仕様は
[`docs/tubed-spec.md`](../../docs/tubed-spec.md)。

**同じブロックを両方の宛先に流さない。** 自分のカーネル乱数の種を公開プールに
出さないための、この実装の中心にある約束。配分は `kernel_share` で決める。

## モジュール構成

| ファイル | 責務 |
|---|---|
| `main.rs` | 配線とメインループ。各モジュールの間を繋ぐだけ |
| `config.rs` | `/etc/tubed/config.toml` の読み込みと検証。token を Debug に出さない |
| `frame.rs` | シリアル行 (`V`/`E`/`S`/`W`) のパーサ。出自を `enum Source` で縛る |
| `serial_source.rs` | ポートの開閉・再接続・行の切り出し、`(boot_id, seq)` の重複排除 |
| `router.rs` | `kernel_share` に従う決定論的な宛先決定(累積誤差法) |
| `kernel_sink.rs` | `ioctl(RNDADDENTROPY)` によるプール注入とエントロピー計上 |
| `pipe_sink.rs` | `POST /ingest`。200 のときだけキューをクリア、指数バックオフ |
| `status.rs` | 10秒ごとの1行表示の組み立て |

`status.rs` は他モジュールの内部を覗かず、`Snapshot` を受け取って整形するだけ。

## ビルド

```sh
cd host/tubed
cargo build --release        # target/release/tubed
cargo test                   # パーサ・配分・重複排除のユニットテスト
```

Linux 専用(`RNDADDENTROPY` を使う)。

## インストール

```sh
# 1. バイナリ
sudo install -m 0755 target/release/tubed /usr/local/bin/tubed

# 2. /dev/tubelet を固定する udev ルール
sudo install -m 0644 udev/99-tubelet.rules /etc/udev/rules.d/99-tubelet.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
ls -l /dev/tubelet           # → /dev/ttyUSB0 などへのシンボリックができる

# 3. 専用ユーザー(設定より先に作る。設定の所有権を渡すため)
sudo useradd --system --no-create-home --shell /usr/sbin/nologin tubed

# 4. 設定(INGEST_TOKEN を含む。tubed だけが読める 0640)
sudo install -D -o root -g tubed -m 0640 config.example.toml /etc/tubed/config.toml
sudo $EDITOR /etc/tubed/config.toml

# 5. サービス
sudo install -m 0644 systemd/tubed.service /etc/systemd/system/tubed.service
sudo systemctl daemon-reload
sudo systemctl enable --now tubed
journalctl -u tubed -f
```

`RNDADDENTROPY` には `CAP_SYS_ADMIN` が要る。service は root ではなく
`User=tubed` + `AmbientCapabilities=CAP_SYS_ADMIN` で動かす。

## 手で動かす(イベント当日のプロジェクタ表示など)

```sh
sudo systemctl stop tubed
sudo /usr/local/bin/tubed /etc/tubed/config.toml
```

```
=== 乱数の管 tubed 0.1.0 ===
設定: /etc/tubed/config.toml
配分: /dev/random 50% / kuda 50%
カーネル: /dev/urandom (1イベント=1bit で計上)
kuda: https://kuda.kojiran.workers.dev 疎通OK pool_remaining=20034 version=2026-07-20
シリアル: /dev/tubelet 115200bps
tubelet 起動: fw=usb-0.1.0 boot=b5f976ff mode=geiger
CPM=23 events=1234 recv=12blk | kernel=6blk/1.5Kb avail=256 | kuda=96B last_post=200(45s ago) pool=20034 | link=OK
```

## 確認

注入できているかは `kernel=` のブロック数で見る。`avail` は Linux 5.17 以降
(5.10.119 / 5.15.44 にも backport 済み)では 256 で飽和するので、増減を指標に
してはいけない。

```sh
cat /proc/sys/kernel/random/entropy_avail     # 現行カーネルでは 256 のまま
curl -s https://kuda.kojiran.workers.dev/status | jq .pool_remaining
```

## よく引っかかるところ

- **`link=DOWN` のまま** — `/dev/tubelet` が無い。udev ルールを入れたか、
  ESP32 が挿さっているか (`lsusb` に `1a86:7523` が見えるか) を確認する。
- **`RNDADDENTROPY が拒否された`** — `CAP_SYS_ADMIN` が無い。権限は起動時に
  確かめるので、この場合はサービスが上がらず(`Restart=always` で再起動を繰り返す)。
  手動起動なら sudo、サービスなら unit の `AmbientCapabilities` を確認する。
- **`kuda=...` が動かない** — `kernel_share = 1.0` になっていないか。
  `last_post` が 401 なら token 違い、413 ならキューが 64KiB を超えている。
- **`recv` が増えない** — ファームが `TEST_MODE 0` で線源も無い場合、
  512イベント溜まるまで(バックグラウンド 20〜30CPM で約20分)ブロックは出ない。
