// 乱数の管・第二源泉 ESP32 ファーム — 設定サンプル。
//
//   cp include/config.example.h include/config.h
// して config.h に実値を入れる。config.h は gitignore 対象(コミット禁止)。
// INGEST_TOKEN はシリアルにも出さない(ファーム側で伏せている)。
#pragma once

// ── 必須 ─────────────────────────────────────────────
#define WIFI_SSID     "your-wifi-ssid"
#define WIFI_PASSWORD "your-wifi-password"
#define PIPE_URL      "https://kuda.kojiran.workers.dev"  // 末尾スラッシュなし
#define INGEST_TOKEN  "replace-with-worker-secret"        // Worker の Secret と同じ値

// ── ピン ─────────────────────────────────────────────
#define GPIO_PULSE 4     // ガイガー基板 VIN(パルス出力・負論理)→ GPIO4
#define GPIO_LED   2     // オンボードLED(検出時に短く点滅)

// ── しきい値・パイプライン ───────────────────────────
#define DEADTIME_US    300   // これ未満(µs)の間隔のパルスは破棄(デッドタイム+チャタリング)
#define WHITEN_EVENTS  256   // SHA-256 に食わせるイベント数(=収集バイト数)→ 出力32B
#define SEND_THRESHOLD 64    // 送信キューがこのバイト数以上で送信
#define SEND_MIN       32    // 「最終送信から10分」経過時に送る最小バイト数
#define SEND_IDLE_MS   (10UL * 60 * 1000)  // 10分
#define QUEUE_MAX      4096  // 送信キュー上限(4KiB)。満杯で新規蓄積を停止

// ── テストモード ─────────────────────────────────────
// 1 で GPIO 割り込みの代わりに擬似ポアソン過程で駆動(ガイガー未接続でも全経路検証)。
// TEST_MODE 時は source="test"(本番 geiger と混ざらない)。
#define TEST_MODE 0
#define TEST_CPM  25    // TEST_MODE の平均CPM

// ── 任意: ルートCA検証 ───────────────────────────────
// 定義すると setCACert で証明書検証。未定義だと setInsecure(下記TODO)。
// Cloudflare のエッジ証明書のルートCA(PEM)を貼る。
// #define ROOT_CA_CERT \
//   "-----BEGIN CERTIFICATE-----\n" \
//   "...\n" \
//   "-----END CERTIFICATE-----\n"
