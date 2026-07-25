// 乱数の管・第二源泉 ESP32 ファーム(USB版) — 設定サンプル。
//
// cp include/config.example.h include/config.h
// して config.h に実値を入れる。config.h は gitignore 対象(コミット禁止)。
//
// このファームは秘密情報を一切持たない。kuda への送信も /dev/random への注入も
// ホスト側の tubed が行う(docs/tubed-spec.md)。ESP32 はエントロピー源に専念する。
#pragma once

// ── ピン ─────────────────────────────────────────────
#define GPIO_PULSE 4 // 検出パルス入力 → GPIO4
#define GPIO_LED 2   // オンボードLED(検出時に短く点滅)

// ── パルスの電気的性質(キットによって違う) ───────────
// CAJOE / RadiationD v1.1 — VIN は負論理(通常High→検出時Low)。3V なので直結可。
//   #define PULSE_INPUT_MODE INPUT_PULLUP
//   #define PULSE_EDGE FALLING
//   #define DEADTIME_US 300
//
// 秋月 AE-RADIATIONDOSIMETER (PINフォトダイオード) — 圧電スピーカー駆動を拾う。
// 正論理で、1回の検出が矩形波バーストになるためデッドタイムを長めに取る。
// 5V 系なので 10kΩ+20kΩ で分圧してから GPIO に入れる(ESP32 は 5V トレラントではない)。
// 分圧の下側抵抗がプルダウンを兼ねるので、内部プルダウンは使わない
// (内部の約45kΩが並列に入ると分圧比がずれる)。
//   #define PULSE_INPUT_MODE INPUT
//   #define PULSE_EDGE RISING
//   #define DEADTIME_US 50000
#define PULSE_INPUT_MODE INPUT_PULLUP // INPUT_PULLUP / INPUT_PULLDOWN / INPUT
#define PULSE_EDGE FALLING            // FALLING / RISING

// ── しきい値・パイプライン ───────────────────────────
// これ未満(µs)の間隔のパルスは破棄する。GM管のデッドタイム/チャタリング対策であり、
// 1回の検出が複数エッジになるキットでは「バースト長より長く」設定する。
#define DEADTIME_US 300
#define WHITEN_EVENTS 256   // SHA-256 に食わせるイベント数(=収集バイト数)→ 出力32B
#define BLOCK_QUEUE_MAX 4096 // 未送出ブロックの保持上限(4KiB)。満杯で新規蓄積を停止

// ── シリアル ─────────────────────────────────────────
#define SERIAL_BAUD 115200

// ── 配線・極性の実測用 ───────────────────────────────
// 1 にすると、受理/破棄を問わず観測した間隔を "D <µs> <ok|dead>" 行として出す。
// 1回の検出が何エッジになるか(バースト長)を見てデッドタイムを決めるのに使う。
// tubed は D 行を未知の行として無視するが、D 行の Δt 下位8bit は白色化に食わせる
// 入力そのもの。シリアルを覗ける者に、その後注入されるブロックを再現されてしまう。
// **配線確認のときだけ 1 にし、本番は必ず 0 に戻して焼き直すこと。**
#define DEBUG_INTERVALS 0

// ── テストモード ─────────────────────────────────────
// 1 で GPIO 割り込みの代わりに擬似ポアソン過程で駆動(ガイガー未接続でも全経路検証)。
// TEST_MODE 時は E 行の src が "test" になり、本番の geiger 粒と混ざらない。
#define TEST_MODE 0
#define TEST_CPM 25 // TEST_MODE の平均CPM
