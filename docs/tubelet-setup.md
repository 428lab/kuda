# tubelet セットアップ手順 — 検出キットから /dev/random と kuda まで

「USB に挿すだけで管に繋がる物理乱数デバイス」をゼロから組み上げる通し手順。
各部品の詳細は [`firmware/geiger/README.md`](../firmware/geiger/README.md) と
[`host/tubed/README.md`](../host/tubed/README.md) にある。仕様は
[`esp32-farm-spec.md`](esp32-farm-spec.md) / [`tubed-spec.md`](tubed-spec.md)。

```
[検出キット] --パルス--> [ESP32] --USBシリアル--> [tubed] --+--> /dev/random
                                                            +--> kuda /ingest
```

## 用意するもの

- 放射線検出キット(下の「キット別の配線」のいずれか)
- Freenove ESP32-WROOM-32E(または generic esp32dev 相当)
- メス-メスのジャンパ線
- 分圧用の抵抗 2〜3本(秋月キットの場合のみ。1/4W 10kΩ が3本あれば足りる)
- Linux ホスト(常時起動しているもの。ここに USB で挿す)
- 母艦(ファームを焼く PC。PlatformIO が動けば OS は問わない)

## 1. キット別の配線

### CAJOE / RadiationD v1.1(ガイガー管)

3本を直結する。パルスは3V負論理なのでレベル変換不要。

| キット | ESP32 |
|---|---|
| VIN (パルス出力) | GPIO4 |
| GND | GND |
| 5V | 5V (VUSB) |

`config.h`:

```c
#define PULSE_INPUT_MODE INPUT_PULLUP
#define PULSE_EDGE FALLING
#define DEADTIME_US 300
```

### 秋月 AE-RADIATIONDOSIMETER(PINフォトダイオード)

このキットには「1パルス = 1検出」の端子が用意されていないので、**圧電スピーカー
(PT08)の駆動信号**を拾う。2本の端子のうち、基板の GND と導通しない方が信号側
(テスターの導通モードで確認する)。

**5V 系なので直結してはいけない。** ESP32 の GPIO は 5V トレラントではない。

```
圧電スピーカーの信号側 --[10kΩ]--+-- ESP32 GPIO4
                                 |
                              [20kΩ]     (10kΩ 2本直列でよい)
                                 |
キットの GND ---------------------+-- ESP32 GND
```

下側 ÷ (上側 + 下側) が 0.66 以下になる組み合わせなら値は自由(1k:2k でも 4.7k:10k でも可)。
**ESP32 の 5V/VIN は繋がない。** このキットは 9V 電池で独立給電されるので、電源を
混ぜる必要がない。

`config.h`(デッドタイムは次の節で実測して決める):

```c
#define PULSE_INPUT_MODE INPUT   // 分圧の下側抵抗がプルダウンを兼ねる
#define PULSE_EDGE RISING
#define DEADTIME_US 50000        // 暫定。実測で確定する
```

内部プルダウンを使わないのは、約45kΩが分圧に並列に入って比がずれるため。

## 2. ファームを焼く

```sh
cd firmware/geiger
cp include/config.example.h include/config.h
$EDITOR include/config.h          # 上のキット別設定を反映
pio run -t upload
```

## 3. 極性とデッドタイムを実測して決める

`config.h` で `DEBUG_INTERVALS 1` にして焼くと、観測した間隔がすべて出る。

```
D 250 dead      <- デッドタイムで捨てた間隔
D 1043827 ok    <- 受理してエントロピーに使った間隔
```

キットを動かした状態で数分眺めて、次を判断する。

- **`S` 行の cpm が 0 のまま / D 行が出ない** — 極性が逆か、配線が繋がっていない。
  `PULSE_EDGE` を反転して焼き直す。
- **1回のクリック音で D 行が何本も出る** — 圧電駆動が矩形波バーストになっている。
  `dead` が連続したあと `ok` が来るまでの合計がバースト長なので、`DEADTIME_US` を
  それより長くする(数十 ms)。そうしないと 1 回の検出を何十イベントとして数えてしまう。
- **`ok` の間隔が特定の値の倍数に偏る** — キット側のマイコンが検出時刻を
  ポーリング周期に丸めている。Δt 下位8bit のエントロピーがその分目減りするので、
  `tubed` 側の `kernel.bits_per_event` を下げる(例: 1 → 0 は不可なので、
  `WHITEN_EVENTS` を増やして1ブロックあたりの申告ビットを相対的に下げる)か、
  マイコンを経由しない取り出し口を探す。**間隔が µs 単位でばらついていることを
  必ず目で確かめる。** ここが崩れていると、白色化しても中身が薄い。

決まったら `DEBUG_INTERVALS 0` に戻して焼き直す。

## 4. ホスト側(tubed)

Rust ツールチェーンが無ければ入れる(`~/.cargo` に入るだけで sudo は不要)。

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
. "$HOME/.cargo/env"
```

ビルドして設置する。

```sh
cd host/tubed
cargo build --release
cargo test                    # パーサ・配分・重複排除

sudo install -m 0755 target/release/tubed /usr/local/bin/tubed

# /dev/tubelet を固定する(CH340 なら既定のまま。CP2102 版はルール内のコメント参照)
sudo install -m 0644 udev/99-tubelet.rules /etc/udev/rules.d/99-tubelet.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
ls -l /dev/tubelet

# 設定。token は Worker の INGEST_TOKEN
sudo install -D -m 0600 config.example.toml /etc/tubed/config.toml
sudo $EDITOR /etc/tubed/config.toml

sudo useradd --system --no-create-home --shell /usr/sbin/nologin tubed
sudo install -m 0644 systemd/tubed.service /etc/systemd/system/tubed.service
sudo systemctl daemon-reload
sudo systemctl enable --now tubed
journalctl -u tubed -f
```

`RNDADDENTROPY` には `CAP_SYS_ADMIN` が要る。unit は root ではなく
`User=tubed` + `AmbientCapabilities=CAP_SYS_ADMIN` で最小限に絞っている。

## 5. 段階的に検証する

一度に全部繋ぐと切り分けが効かないので、順に上げる。

### 5-1. カーネル注入だけ(キット不要)

ファームを `TEST_MODE 1` で焼き、`kernel_share = 1.0` にする。kuda には1バイトも
送らないのでプールを test 粒で汚さない。`TEST_CPM` を一時的に上げる(例 6000)と
数秒で1ブロック出るので待たなくてよい。

```sh
sudo /usr/local/bin/tubed /etc/tubed/config.toml
```

`kernel=` のブロック数が増えていけば ioctl が通っている。権限不足なら
`CAP_SYS_ADMIN が要る` と明示して落ちる。

> `avail=`(`/proc/sys/kernel/random/entropy_avail`)は **Linux 5.18 以降 256 で
> 飽和する**ので、注入しても増えない。増減で判断してはいけない。

### 5-2. kuda への到達(キット不要)

`kernel_share` を下げて数分だけ動かし、`/status` の `pool_remaining` が増えるのを
見たら止める。TEST_MODE の粒は `esp_random()` 由来で物理乱数ではないため、
**長時間流し込まない**(規律「疑似乱数で埋めない」)。

```sh
curl -s https://kuda.kojiran.workers.dev/status | jq .pool_remaining
```

### 5-3. 実パルス

`TEST_MODE 0` で焼き、キットを繋ぐ。`S` 行の cpm が動き、オンボード LED(GPIO2)が
検出ごとに点滅すれば経路が生きている。キットが無い段階でも、GPIO4 と GND を
ジャンパで短く触れさせれば ISR/LED/CPM の確認だけはできる。

### 5-4. 本番

`kernel_share` を運用値(既定 0.5)にして systemd で常駐させる。

## 検証できたと言える条件

1. `kernel=` のブロック数が増える(= `RNDADDENTROPY` が成功している)
2. `pool_remaining` が増える
3. 実パルスで cpm が動き LED が点滅する
4. USB 抜き差し・ネット断からの復帰で二重投入が起きない
   (`recv` は増えるが `dup` は増えない、`last_post` が 200 になるまでキューが減らない)
5. ESP32 の電源断→再起動で正常に再開する(`boot=` が変わり `seq` が 0 から振り直される)
6. `INGEST_TOKEN` がログ・journal・リポジトリに出ていない

## 詰まったときに見るところ

| 症状 | 見るところ |
|---|---|
| `link=DOWN` のまま | `/dev/tubelet` の有無、udev ルール、`lsusb`(CH340 は `1a86:7523`) |
| `RNDADDENTROPY が拒否された` | `CAP_SYS_ADMIN`。手動起動なら sudo、unit なら `AmbientCapabilities` |
| `last_post=401` | `/etc/tubed/config.toml` の token |
| `last_post=413` | キューが 64KiB を超えた。`queue_max_bytes` を下げる |
| `recv` が増えない | ブロックは 256 イベント溜まって初めて出る。20〜30CPM なら約10分かかる |
| cpm が異常に大きい | 1回の検出が複数エッジになっている。`DEADTIME_US` を上げる |
| `[QUEUE FULL]` | 送信できないまま上限に達した。規律により新規蓄積を止めている(粒は捨てない) |
