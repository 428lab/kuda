# SPEC: tubed — 物理エントロピーの配管 (Ubuntu ホスト常駐)

## 目的

USB で刺さった tubelet(ガイガー基板 + ESP32)が吐く 32B ブロックを読み、
**カーネルのエントロピープール**と **kuda の `POST /ingest`** に配る常駐デーモン。

ESP32 側にネットワークも秘密情報も置かないための対になる部品
(`docs/esp32-farm-spec.md`)。実装は `host/tubed`(Rust)。

```
tubelet ──USBシリアル──▶ tubed ──┬──▶ ioctl(RNDADDENTROPY) → /dev/random
                                 └──▶ POST /ingest        → kuda
```

## 宛先の分離 (この仕様の要)

**同じ32Bブロックを両方の宛先に流さない。** 流してしまうと、自分のカーネル
乱数の種を公開プールに出すことになる。宛先は必ずどちらか一方。

配分は `split.kernel_share` (0.0..=1.0) で決める。乱数ではなく累積誤差法
(`acc += share; acc >= 1.0 ならカーネルへ`)で決定論的に振り分けるため、
指定比率に短期でも収束し、どちらへ行ったかが再現可能になる。

- `1.0` — 全部カーネル。`[pipe]` を省略でき、トークンを置く必要も無い
- `0.5` — 交互(既定)
- `0.0` — 全部 kuda

## 処理

1. **読み取り** — `serial.device`(既定 `/dev/tubelet`)を開き、行単位で読む。
   ポートが無ければ2秒おきに開き直す。ブートローダの ROM メッセージなど
   解釈できない行は黙って捨てる。
2. **解釈** — `V` / `E` / `S` / `W` 行を解釈する。`E` 行以外は表示用。
   `source` は `geiger` / `test` のみ受理する(型で縛る)。
3. **重複排除** — `(boot_id, seq)` を直近4096件まで記憶し、既知のキーは捨てる。
   ESP32 が再起動すると `boot_id` が変わるので、`seq` が 0 に戻っても衝突しない。
4. **配分** — `kernel_share` に従って宛先を1つ選ぶ。
5. **カーネル注入** — `ioctl(RNDADDENTROPY)` でプールに混ぜ、推定値を加算する。
   計上は保守的に `min(events * bits_per_event, 8 * バイト数)`。既定の
   `bits_per_event = 1` なら 512イベントのブロックで 256bit(32Bの上限で頭打ち)。
   出自が `test` の粒は疑似乱数なので、プールには混ぜても加算は 0。
6. **kuda 送信** — キューが `send_threshold`(既定64B)以上、または最終送信から
   `idle_secs`(既定10分)経過かつ `send_min`(既定32B)以上で
   `POST /ingest {"bytes": "<base64>", "source": "<geiger|test>"}`。

## 規律 (変更禁止)

- **疑似乱数で埋めない** — 溜まった分だけ送る。管が細い日は細いまま。
- **二重投入禁止** — `POST /ingest` が **200 を返したときだけ**キューをクリアする。
  失敗時は指数バックオフ(30s→60s→…→上限10分)で、同じバイト列を保持したまま再試行する。
  再送には同じ `nonce` を添える。Worker が INSERT を終えた後にレスポンスだけ失われた
  場合(タイムアウト・接続断)でも、二度目は `/ingest` の冪等キーで弾かれてプールには
  入らない。**再送中のバッチは固定し、後から来た粒を混ぜない** — 混ぜると nonce と
  内容がずれ、追加分まで受理済み扱いで捨てられてしまう。
- **重複排除** — ESP32 から同じ `(boot_id, seq)` を二度受け取っても一度しか使わない。
  こちらは確実に効く(USB の再接続やホスト側の再読み込みで重複しない)。
- **出自を混ぜない** — `geiger` と `test` は別のキューに積み、1回の POST に混ぜない。
- **キュー満杯時** — 上限(既定4KiB)に達したら新規蓄積を停止して警告。
  古い粒の破棄も新しい粒の上書きもしない。
- **同じ粒を二箇所に配らない** — 上記「宛先の分離」。

## 設定 (`/etc/tubed/config.toml`, 0600)

`host/tubed/config.example.toml` を参照。`pipe.token` は Worker の
`INGEST_TOKEN`。**ログにも Debug 出力にも載せない**(`Debug` を手書きして
`***` に伏せている)。

`pipe.queue_max_bytes` は kuda の `/ingest` 上限に合わせて 64KiB 以下。

## 可観測性

10秒ごとに1行。イベント当日はこれをプロジェクタに映す。

```
CPM=23 events=1234 recv=12blk | kernel=6blk/1.5Kb avail=256 | kuda=96B last_post=200(45s ago) pool=20034 | link=OK
```

- `CPM` / `events` — tubelet の `S` 行から
- `recv` — tubed が受け取ったブロック数(`dup` が出たら重複排除が働いた印)
- `kernel` — 注入したブロック数と計上ビット数。`avail` は
  `/proc/sys/kernel/random/entropy_avail` の生値だが、Linux 5.17 以降
  (5.10.119 / 5.15.44 にも backport)はプールが 256bit で飽和するため、注入しても
  増えない。注入できているかは `kernel=` のブロック数で判断する
- `kuda` — 未送信キュー、直近のHTTPステータスと経過、`pool` は kuda の残量
- `link` — シリアルが繋がっているか

起動時に配分・カーネルデバイス・kuda の疎通(`GET /status`)を表示する。
疎通しなくても起動し、粒を溜めて復帰を待つ。

## 権限

`RNDADDENTROPY` には `CAP_SYS_ADMIN` が要る(単なる write ではプールに
混ざるだけで推定値は増えない)。`systemd/tubed.service` は root ではなく
`User=tubed` + `AmbientCapabilities=CAP_SYS_ADMIN` + `SupplementaryGroups=dialout`
とし、`ProtectSystem=strict` などで周囲を固める(CAP_SYS_ADMIN 自体は事実上
root 相当なので、これは「最小限」ではなく「root では動かさない」という程度の意味)。

権限は**起動時に長さ0・加算0の `RNDADDENTROPY` を撃って確かめ**、通らなければ
そこで終了する。粒が来るたびに注入だけ失敗して捨てられ続け、それでもプロセスは
動いて見える、という状態を作らないため。この要求はプールにも推定値にも触れない。

## 受け入れ条件

1. `kernel_share` の比率どおりに、ステータス行の `kernel=` のブロック数と
   kuda の `pool_remaining` が増える(`entropy_avail` は 256 で飽和するので使えない)
2. ネット断→復帰で蓄積分が送信され、ESP32 側の再送・再起動をまたいで
   `(boot_id, seq)` の重複が排除される
3. USB 抜き差し・tubed 再起動で正常に再開する
4. `INGEST_TOKEN` がログ・journal・リポジトリに露出しない

## 非目標

- rngd の置き換え全般(このデーモンは tubelet 専用)
- 線量計算
- 複数 tubelet の同時接続(CH340 はシリアル番号を持たず区別できない)
