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

手持ちの抵抗で代用するなら、分圧比 = 下側 ÷ (上側 + 下側) が **0.55〜0.67** に収まる
組み合わせにする(10k:20k と 1k:2k はどちらも 0.67、10k:15k は 0.60)。

- 上限 0.67 — 5V × 0.67 = 3.35V。ESP32 の絶対最大定格 VDD+0.3 = 3.6V を割らない
- 下限 0.55 — 5V × 0.55 = 2.75V。H と判定される閾値 0.75×3.3 = 2.48V を上回る
- 合計は 10k〜100kΩ 程度。小さすぎるとキット側の負荷になり、大きすぎるとノイズを拾う
- 4.7k:10k は 0.68(3.40V)で範囲外

上側の抵抗には、圧電スピーカーのリンギング(容量性なので駆動停止時に GND 以下へ振れる)が
ESP32 の保護ダイオードに流し込む電流を制限する役目もある。**抵抗の順序を入れ替えて
GPIO 側を裸にしない。**

**ESP32 の 5V/VIN は繋がない。** このキットは 9V 電池で独立給電されるので電源を混ぜる
必要がなく、GND だけ共通にする。同じ理由で、**ESP32 の USB を挿していない状態で
キットの電源を入れない**(GPIO 経由の逆給電になる)。

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
  `WHITEN_EVENTS` をさらに増やして1イベントあたりの申告ビットを下げるか、
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

# 専用ユーザーを先に作る。設定ファイルの所有権を渡すため
sudo useradd --system --no-create-home --shell /usr/sbin/nologin tubed

# 設定。token は Worker の INGEST_TOKEN
# root:root 0600 にすると User=tubed で読めず、5秒おきの再起動ループになる
sudo install -D -o root -g tubed -m 0640 config.example.toml /etc/tubed/config.toml
sudo $EDITOR /etc/tubed/config.toml

sudo install -m 0644 systemd/tubed.service /etc/systemd/system/tubed.service
sudo systemctl daemon-reload
sudo systemctl enable --now tubed
journalctl -u tubed -f
```

`RNDADDENTROPY` には `CAP_SYS_ADMIN` が要る。unit は root ではなく
`User=tubed` + `AmbientCapabilities=CAP_SYS_ADMIN` で最小限に絞っている。

## 5. 段階的に検証する

一度に全部繋ぐと切り分けが効かないので、順に上げる。

> **TEST_MODE の粒を本番の kuda に入れない。** `esp_random()` 由来で物理乱数では
> なく、`/ingest` に入った粒はそのまま `/drop` から払い出される(規律「疑似乱数で
> 埋めない」)。本番 URL に向けるのは 5-3 で実パルスが出てからにする。

シリアルポートは排他オープンなので、手で動かすときは先にサービスを止める。

```sh
sudo systemctl stop tubed
```

### 5-1. カーネル注入だけ(キット不要)

ファームを `TEST_MODE 1` で焼き、`kernel_share = 1.0` にする。kuda には1バイトも
送らない。`TEST_CPM` を一時的に上げる(例 6000)と数秒で1ブロック出るので待たなくてよい。

```sh
sudo /usr/local/bin/tubed /etc/tubed/config.toml
```

`kernel=` のブロック数が増えていけば ioctl が通っている。TEST_MODE の粒は疑似乱数
なので推定値には加算せず、`kernel=12blk/0b` のようにビット数は 0 のままになる。
これは正常で、見るのはブロック数のほう。

権限が足りない場合は、粒を待たずに**起動した時点で**
`RNDADDENTROPY が拒否された。CAP_SYS_ADMIN が要る` を出して終了する
(systemd 経由だと `Restart=always` で再起動を繰り返すので、`journalctl -u tubed`
の先頭を見る)。

> `avail=`(`/proc/sys/kernel/random/entropy_avail`)は **Linux 5.17 以降** —
> 5.10.119 / 5.15.44 にも backport されている — で 256 に飽和するので、注入しても
> 増えない。増減で判断してはいけない。

### 5-2. kuda への到達(キット不要・ローカル Worker 相手)

本番プールを test 粒で汚さないよう、ローカルの Worker に向けて確認する。
リポジトリのルートで:

```sh
pnpm exec wrangler dev            # http://127.0.0.1:8787
```

`/etc/tubed/config.toml` の `pipe.url` を一時的に `http://127.0.0.1:8787` にし、
`token` は `.dev.vars` の `INGEST_TOKEN` に合わせる。`kernel_share` を下げて動かし、
`last_post=200` になり `pool` が増えれば HTTP 経路は生きている。
**確認できたら `pipe.url` と `token` の両方を本番の値に戻す**(token を戻し忘れると
5-3 で `last_post=401` になる)。

### 5-3. 実パルス

`TEST_MODE 0` で焼き、キットを繋ぐ。`S` 行の cpm が動き、オンボード LED(GPIO2)が
検出ごとに点滅すれば経路が生きている。キットが無い段階でも、GPIO4 と GND を
ジャンパで短く触れさせれば ISR/LED/CPM の確認だけはできる。

ここで初めて本番 URL に向けてよい。

```sh
curl -s https://kuda.kojiran.workers.dev/status | jq .pool_remaining
```

### 5-4. 本番

`kernel_share` を運用値(既定 0.5)にして systemd で常駐させる。

```sh
sudo systemctl start tubed
```

## 検証できたと言える条件

1. `kernel=` のブロック数が増える(= `RNDADDENTROPY` が成功している)
2. `pool_remaining` が増える
3. 実パルスで cpm が動き LED が点滅する
4. USB 抜き差しからの復帰で二重投入が起きない(`recv` は増えるが `dup` は増えない)。
   ネット断からの復帰では `last_post` が 200 になるまでキューが減らず、復帰後に
   蓄積分が送られる。Worker が受理済みだった分は `nonce` で弾かれ、プールには
   二重に入らない
5. ESP32 の電源断→再起動で正常に再開する(`boot=` が変わり `seq` が 0 から振り直される)
6. `INGEST_TOKEN` がログ・journal・リポジトリに出ていない

## 詰まったときに見るところ

| 症状 | 見るところ |
|---|---|
| `link=DOWN` のまま | `/dev/tubelet` の有無、udev ルール、`lsusb`(CH340 は `1a86:7523`) |
| `RNDADDENTROPY が拒否された` | `CAP_SYS_ADMIN`。手動起動なら sudo、unit なら `AmbientCapabilities` |
| `last_post=401` | `/etc/tubed/config.toml` の token |
| `last_post=413` | キューが 64KiB を超えた。`queue_max_bytes` を下げる |
| `recv` が増えない | ブロックは 512 イベント溜まって初めて出る。20〜30CPM なら約20分かかる |
| cpm が異常に大きい | 1回の検出が複数エッジになっている。`DEADTIME_US` を上げる |
| `[QUEUE FULL]` | 送信できないまま上限に達した。規律により新規蓄積を止めている(粒は捨てない) |
