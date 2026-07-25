// 乱数の管・第二源泉 — ガイガーカウンター ESP32 ファーム(USB版)
//
// CAJOE / RadiationD v1.1 系ガイガー基板のパルス出力から崩壊イベントの到着時刻を
// 取得し、隣接間隔の下位ビットを SHA-256 で白色化して USB シリアルに吐く。
// 吐いた粒の行き先(/dev/random 注入・kuda への POST)はホスト側の tubed が決める。
//
// 規律(docs/esp32-farm-spec.md より・変更禁止):
// - 疑似乱数で埋めない。溜まった分だけ出す。管が細い日は細いまま。
// - 二重投入禁止。全ブロックに (boot_id, seq) が付き、ホストが重複を排除する。
// - キュー満杯(4KiB)時は新規蓄積を停止して警告。古い粒の破棄も上書きもしない。
// - このファームは秘密情報を持たない(WiFi 資格情報も INGEST_TOKEN も無い)。

#include <Arduino.h>
#include <math.h>
#include <Preferences.h> // boot_id の元になるブートカウンタ(NVS)
#include "mbedtls/sha256.h"
#include "mbedtls/base64.h"

#include "config.h"

#if TEST_MODE
#include "esp_random.h" // 合成パルスの間隔生成のみに使う(エントロピーには混ぜない)
#endif

static const char *FW_VERSION = "usb-0.1.0";

#if TEST_MODE
static const char *SOURCE = "test";
#else
static const char *SOURCE = "geiger";
#endif

static const size_t BLOCK_BYTES = 32;  // SHA-256 出力
static const size_t LINE_RESERVE = 96; // E 行1本の最大長(この空きが無ければ書かない)

// ── パルス到着リングバッファ(ISR→ループ) ─────────────────────────
static const uint16_t PULSE_BUF_SIZE = 512;
static volatile uint32_t pulseBuf[PULSE_BUF_SIZE];
static volatile uint16_t pulseHead = 0; // ISR が書く
static volatile uint16_t pulseTail = 0; // ループが読む

// ISR: micros() を積むだけ。満杯なら落とす(ブロックしない)。
static void IRAM_ATTR onPulseISR() {
  uint32_t t = micros();
  uint16_t next = (pulseHead + 1) % PULSE_BUF_SIZE;
  if (next != pulseTail) {
    pulseBuf[pulseHead] = t;
    pulseHead = next;
  }
}

// TEST_MODE / 手動注入用(ISR と同じ積み方)
static inline void pushPulse(uint32_t t) {
  uint16_t next = (pulseHead + 1) % PULSE_BUF_SIZE;
  if (next != pulseTail) {
    pulseBuf[pulseHead] = t;
    pulseHead = next;
  }
}

// ── エントロピー収集・白色化 ───────────────────────────────────────
static uint8_t collectBuf[WHITEN_EVENTS];
static uint16_t collectLen = 0;

// ── 未送出ブロックキュー(FIFO・32Bブロック単位) ───────────────────
static uint8_t blockQueue[BLOCK_QUEUE_MAX];
static uint16_t blockQueueLen = 0;
static bool queueFull = false; // 満杯→新規蓄積停止

// ── 間隔計算の状態 ─────────────────────────────────────────────────
static uint32_t lastAcceptedMicros = 0;
static bool haveLastAccepted = false;

// ── 統計/表示 ──────────────────────────────────────────────────────
static uint32_t bootId = 0;
static uint32_t blockSeq = 0;      // 出力した E 行の通し番号(boot ごとに0から)
static uint32_t eventsTotal = 0;
static uint32_t deadtimeDropped = 0;
static uint32_t blocksTotal = 0;   // 生成した32Bブロック数
static uint16_t cpmBuckets[60];    // 秒ごとの計数(直近60秒 = CPM)
static uint32_t lastBucketSec = 0;
static uint32_t ledOffAtMs = 0;

// ─────────────────────────────────────────────────────────────────

static void sha256(const uint8_t *in, size_t len, uint8_t out[32]) {
  // is224=0 → SHA-256。toolchain が deprecated 警告を出す場合は
  // mbedtls_sha256_ret(in, len, out, 0) に置き換える。
  mbedtls_sha256(in, len, out, 0);
}

static void warn(const char *msg) {
  Serial.printf("W %s\n", msg);
}

// boot_id は「同じ基板の別の起動」で必ず変わらなければならない。ホスト側の重複排除が
// (boot_id, seq) を鍵にしているので、衝突すると新しい粒が既出扱いで捨てられる。
// RF 無効のこのファームでは esp_random() に一意性の保証が無いため、個体を表す MAC と
// 起動ごとに単調増加する NVS のカウンタから導く。
static uint32_t makeBootId() {
  Preferences prefs;
  uint32_t count = 0;
  if (prefs.begin("tubelet", false)) {
    count = prefs.getUInt("boots", 0) + 1;
    prefs.putUInt("boots", count);
    prefs.end();
  } else {
    warn("NVS を開けない - boot_id が起動ごとに変わらず、重複排除が誤作動する");
  }

  uint8_t seed[10];
  uint64_t mac = ESP.getEfuseMac();
  for (int i = 0; i < 6; i++) seed[i] = (uint8_t)(mac >> (8 * i));
  for (int i = 0; i < 4; i++) seed[6 + i] = (uint8_t)(count >> (8 * i));

  uint8_t digest[32];
  sha256(seed, sizeof(seed), digest);
  return ((uint32_t)digest[0] << 24) | ((uint32_t)digest[1] << 16) |
         ((uint32_t)digest[2] << 8) | (uint32_t)digest[3];
}

static void rollBuckets() {
  uint32_t sec = millis() / 1000;
  if (sec == lastBucketSec) return;
  // 経過した秒のスロットをゼロ埋め(最大60個まで)
  uint32_t gap = sec - lastBucketSec;
  if (gap > 60) gap = 60;
  for (uint32_t i = 0; i < gap; i++) {
    lastBucketSec++;
    cpmBuckets[lastBucketSec % 60] = 0;
  }
  lastBucketSec = sec;
}

static void bucketAdd() {
  rollBuckets();
  cpmBuckets[(millis() / 1000) % 60]++;
}

static uint16_t currentCPM() {
  rollBuckets();
  uint32_t sum = 0;
  for (int i = 0; i < 60; i++) sum += cpmBuckets[i];
  return (uint16_t)sum;
}

static void enqueueBlock(const uint8_t *block) {
  if (blockQueueLen + BLOCK_BYTES > BLOCK_QUEUE_MAX) {
    if (!queueFull) {
      queueFull = true;
      warn("block queue full (4KiB) - 新規蓄積を停止。ホストの受信待ち");
    }
    return; // 上書きも破棄もしない
  }
  memcpy(blockQueue + blockQueueLen, block, BLOCK_BYTES);
  blockQueueLen += BLOCK_BYTES;
}

// 間隔の下位8bitを収集。WHITEN_EVENTS 溜まったら SHA-256 で32Bにしてキューへ。
static void appendEntropyByte(uint8_t b) {
  if (queueFull) return; // 満杯中は新規蓄積を止める(規律)
  collectBuf[collectLen++] = b;
  if (collectLen >= WHITEN_EVENTS) {
    uint8_t hash[BLOCK_BYTES];
    sha256(collectBuf, WHITEN_EVENTS, hash);
    enqueueBlock(hash);
    blocksTotal++;
    collectLen = 0;
  }
}

// リングバッファを消化。デッドタイム除去→間隔→エントロピー、CPM/LED更新。
static void processPulses() {
  while (pulseTail != pulseHead) {
    uint32_t t = pulseBuf[pulseTail];
    pulseTail = (pulseTail + 1) % PULSE_BUF_SIZE;

    if (haveLastAccepted) {
      uint32_t dt = t - lastAcceptedMicros; // uint32 でラップアラウンドは自然に処理
#if DEBUG_INTERVALS
      Serial.printf("D %lu %s\n", (unsigned long)dt, dt < DEADTIME_US ? "dead" : "ok");
#endif
      if (dt < DEADTIME_US) {               // デッドタイム: 破棄(lastAccepted は更新しない)
        deadtimeDropped++;
        continue;
      }
      appendEntropyByte((uint8_t)(dt & 0xFF));
    }
    lastAcceptedMicros = t;
    haveLastAccepted = true;

    eventsTotal++;
    bucketAdd();
    digitalWrite(GPIO_LED, HIGH);
    ledOffAtMs = millis() + 15;
  }
}

// キュー先頭のブロックから順に E 行として吐く。書ける分だけ出し、残りは保持する。
static void flushBlocks() {
  while (blockQueueLen >= BLOCK_BYTES) {
    if ((size_t)Serial.availableForWrite() < LINE_RESERVE) return;

    char b64[48];
    size_t olen = 0;
    if (mbedtls_base64_encode((unsigned char *)b64, sizeof(b64), &olen,
                              blockQueue, BLOCK_BYTES) != 0) {
      warn("base64 encode 失敗");
      return;
    }
    b64[olen] = '\0';
    Serial.printf("E %08x %lu %u %s %s\n", bootId, (unsigned long)blockSeq,
                  (unsigned)WHITEN_EVENTS, SOURCE, b64);
    blockSeq++;

    blockQueueLen -= BLOCK_BYTES;
    memmove(blockQueue, blockQueue + BLOCK_BYTES, blockQueueLen);
    if (queueFull) {
      queueFull = false;
      warn("block queue 復帰 - 蓄積を再開");
    }
  }
}

#if TEST_MODE
// 擬似ポアソン過程で合成パルスを注入(平均 TEST_CPM)。乱数はテスト専用に esp_random()。
static uint32_t nextTestMicros = 0;
static void injectTestPulses() {
  uint32_t now = micros();
  while ((int32_t)(now - nextTestMicros) >= 0) {
    pushPulse(nextTestMicros);
    double mean = 60000000.0 / (double)TEST_CPM;             // 平均間隔(µs)
    double u = ((double)esp_random() + 1.0) / 4294967296.0;  // (0,1]
    uint32_t interval = (uint32_t)(-mean * log(u));
    if (interval < DEADTIME_US * 2) interval = DEADTIME_US * 2;
    nextTestMicros += interval;
  }
}
#endif

static void printStatusLine() {
  Serial.printf("S cpm=%u events=%lu dead=%lu blocks=%lu queue=%uB up=%lus%s\n",
                currentCPM(), (unsigned long)eventsTotal,
                (unsigned long)deadtimeDropped, (unsigned long)blocksTotal,
                blockQueueLen, (unsigned long)(millis() / 1000),
                queueFull ? " [QUEUE FULL]" : "");
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(200);
  Serial.println();

  bootId = makeBootId();

  pinMode(GPIO_LED, OUTPUT);
  digitalWrite(GPIO_LED, LOW);
  for (int i = 0; i < 60; i++) cpmBuckets[i] = 0;
  lastBucketSec = millis() / 1000;

#if TEST_MODE
  nextTestMicros = micros();
#else
  pinMode(GPIO_PULSE, PULSE_INPUT_MODE);
  attachInterrupt(digitalPinToInterrupt(GPIO_PULSE), onPulseISR, PULSE_EDGE);
#endif

  Serial.printf("V tubelet %s boot=%08x mode=%s whiten=%u gpio=%d\n", FW_VERSION,
                bootId, SOURCE, (unsigned)WHITEN_EVENTS, GPIO_PULSE);
}

void loop() {
#if TEST_MODE
  injectTestPulses();
#endif
  processPulses();
  flushBlocks();

  // LED 消灯
  if (ledOffAtMs && (int32_t)(millis() - ledOffAtMs) >= 0) {
    digitalWrite(GPIO_LED, LOW);
    ledOffAtMs = 0;
  }

  // 10秒ごとにステータス1行
  static uint32_t lastStatus = 0;
  if (millis() - lastStatus >= 10000) {
    lastStatus = millis();
    printStatusLine();
  }
}
