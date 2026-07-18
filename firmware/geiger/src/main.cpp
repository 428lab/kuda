// 乱数の管・第二源泉 — ガイガーカウンター ESP32 ファーム
//
// CAJOE / RadiationD v1.1 系ガイガー基板のパルス出力から崩壊イベントの到着時刻を
// 取得し、隣接間隔の下位ビットを SHA-256 で白色化して kuda の POST /ingest に送る。
//
// 規律(docs/esp32-farm-spec.md より・変更禁止):
//   - 疑似乱数で埋めない。溜まった分だけ送る。管が細い日は細いまま。
//   - 二重投入禁止。POST が 200 を返したときだけ送信キューをクリアする。
//   - キュー満杯(4KiB)時は新規蓄積を停止して警告。古い粒の破棄も上書きもしない。
//   - INGEST_TOKEN はシリアルに出さない。

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <math.h>
#include "mbedtls/sha256.h"
#include "mbedtls/base64.h"

#include "config.h"

#if TEST_MODE
static const char *SOURCE = "test";
#else
static const char *SOURCE = "geiger";
#endif

// ── パルス到着リングバッファ(ISR→ループ) ─────────────────────────
static const uint16_t PULSE_BUF_SIZE = 512;
static volatile uint32_t pulseBuf[PULSE_BUF_SIZE];
static volatile uint16_t pulseHead = 0;  // ISR が書く
static volatile uint16_t pulseTail = 0;  // ループが読む

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

// ── 送信キュー ─────────────────────────────────────────────────────
static uint8_t sendQueue[QUEUE_MAX];
static uint16_t sendQueueLen = 0;
static bool queueFull = false;  // 満杯→新規蓄積停止

// ── 間隔計算の状態 ─────────────────────────────────────────────────
static uint32_t lastAcceptedMicros = 0;
static bool haveLastAccepted = false;

// ── 統計/表示 ──────────────────────────────────────────────────────
static uint32_t eventsTotal = 0;
static uint16_t cpmBuckets[60];  // 秒ごとの計数(直近60秒 = CPM)
static uint32_t lastBucketSec = 0;
static uint32_t ledOffAtMs = 0;

// ── 送信タイミング/バックオフ ─────────────────────────────────────
static const uint32_t BACKOFF_MIN = 30000;    // 30s
static const uint32_t BACKOFF_MAX = 600000;   // 10min
static uint32_t backoffMs = BACKOFF_MIN;
static uint32_t nextAttemptMs = 0;
static uint32_t lastPostMs = 0;
static int lastPostCode = 0;  // 0 = まだ送っていない

// ─────────────────────────────────────────────────────────────────

static void sha256(const uint8_t *in, size_t len, uint8_t out[32]) {
  // is224=0 → SHA-256。toolchain が deprecated 警告を出す場合は
  // mbedtls_sha256_ret(in, len, out, 0) に置き換える。
  mbedtls_sha256(in, len, out, 0);
}

static void bucketAdd() {
  uint32_t sec = millis() / 1000;
  if (sec != lastBucketSec) {
    // 経過した秒のスロットをゼロ埋め(最大60個まで)
    uint32_t gap = sec - lastBucketSec;
    if (gap > 60) gap = 60;
    for (uint32_t i = 0; i < gap; i++) {
      lastBucketSec++;
      cpmBuckets[lastBucketSec % 60] = 0;
    }
    lastBucketSec = sec;
  }
  cpmBuckets[sec % 60]++;
}

static uint16_t currentCPM() {
  // 直近60秒の合計。呼び出し時点で古いスロットを掃除しておく。
  uint32_t sec = millis() / 1000;
  if (sec != lastBucketSec) {
    uint32_t gap = sec - lastBucketSec;
    if (gap > 60) gap = 60;
    for (uint32_t i = 0; i < gap; i++) {
      lastBucketSec++;
      cpmBuckets[lastBucketSec % 60] = 0;
    }
    lastBucketSec = sec;
  }
  uint32_t sum = 0;
  for (int i = 0; i < 60; i++) sum += cpmBuckets[i];
  return (uint16_t)sum;
}

static void enqueueSend(const uint8_t *data, size_t n) {
  if (sendQueueLen + n > QUEUE_MAX) {
    if (!queueFull) {
      queueFull = true;
      Serial.println("[WARN] send queue full (4KiB) — 新規蓄積を停止。送信復帰待ち");
    }
    return;  // 上書きも破棄もしない
  }
  memcpy(sendQueue + sendQueueLen, data, n);
  sendQueueLen += n;
}

// 間隔の下位8bitを収集。256溜まったら SHA-256 で32Bにして送信キューへ。
static void appendEntropyByte(uint8_t b) {
  if (queueFull) return;  // 満杯中は新規蓄積を止める(規律)
  collectBuf[collectLen++] = b;
  if (collectLen >= WHITEN_EVENTS) {
    uint8_t hash[32];
    sha256(collectBuf, WHITEN_EVENTS, hash);
    enqueueSend(hash, sizeof(hash));
    collectLen = 0;
  }
}

// リングバッファを消化。デッドタイム除去→間隔→エントロピー、CPM/LED更新。
static void processPulses() {
  while (pulseTail != pulseHead) {
    uint32_t t = pulseBuf[pulseTail];
    pulseTail = (pulseTail + 1) % PULSE_BUF_SIZE;

    if (haveLastAccepted) {
      uint32_t dt = t - lastAcceptedMicros;  // uint32 でラップアラウンドは自然に処理
      if (dt < DEADTIME_US) continue;        // デッドタイム: 破棄(lastAccepted は更新しない)
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

#if TEST_MODE
// 擬似ポアソン過程で合成パルスを注入(平均 TEST_CPM)。乱数はテスト専用に esp_random()。
static uint32_t nextTestMicros = 0;
static void injectTestPulses() {
  uint32_t now = micros();
  while ((int32_t)(now - nextTestMicros) >= 0) {
    pushPulse(nextTestMicros);
    double mean = 60000000.0 / (double)TEST_CPM;         // 平均間隔(µs)
    double u = ((double)esp_random() + 1.0) / 4294967296.0;  // (0,1]
    uint32_t interval = (uint32_t)(-mean * log(u));
    if (interval < DEADTIME_US * 2) interval = DEADTIME_US * 2;
    nextTestMicros += interval;
  }
}
#endif

static void makeSecure(WiFiClientSecure &client) {
#ifdef ROOT_CA_CERT
  client.setCACert(ROOT_CA_CERT);
#else
  // TODO: ルートCA検証を実装する。config.h に ROOT_CA_CERT(Cloudflare エッジ証明書の
  //       ルートCA・PEM)を定義すれば上の setCACert に切り替わる。当面は検証なし。
  client.setInsecure();
#endif
}

// base64 エンコード(mbedtls)。out は呼び出し側で十分な領域を確保すること。
static size_t b64encode(const uint8_t *in, size_t inLen, char *out, size_t outCap) {
  size_t olen = 0;
  int rc = mbedtls_base64_encode((unsigned char *)out, outCap, &olen, in, inLen);
  if (rc != 0) return 0;
  return olen;
}

// POST /ingest。200 のときだけ true。キューのクリアは呼び出し側で 200 時のみ。
static bool postIngest() {
  // base64 サイズ: 4*ceil(n/3) + 1
  size_t b64cap = ((sendQueueLen + 2) / 3) * 4 + 1;
  char *b64 = (char *)malloc(b64cap);
  if (!b64) {
    Serial.println("[ERR] base64 malloc 失敗");
    return false;
  }
  size_t b64len = b64encode(sendQueue, sendQueueLen, b64, b64cap);
  if (b64len == 0) {
    free(b64);
    Serial.println("[ERR] base64 encode 失敗");
    return false;
  }

  size_t bodyCap = b64len + 64;
  char *body = (char *)malloc(bodyCap);
  if (!body) {
    free(b64);
    Serial.println("[ERR] body malloc 失敗");
    return false;
  }
  int bodyLen = snprintf(body, bodyCap, "{\"bytes\":\"%s\",\"source\":\"%s\"}", b64, SOURCE);
  free(b64);

  WiFiClientSecure client;
  makeSecure(client);
  HTTPClient http;
  String url = String(PIPE_URL) + "/ingest";
  bool ok = false;
  if (http.begin(client, url)) {
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Authorization", String("Bearer ") + INGEST_TOKEN);
    int code = http.POST((uint8_t *)body, bodyLen);
    lastPostCode = code;
    ok = (code == 200);
    if (!ok) Serial.printf("[WARN] /ingest -> %d\n", code);
    http.end();
  } else {
    lastPostCode = -1;
    Serial.println("[WARN] /ingest http.begin 失敗");
  }
  free(body);
  return ok;
}

static bool shouldSend() {
  if (sendQueueLen == 0) return false;
  if (sendQueueLen >= SEND_THRESHOLD) return true;
  if (sendQueueLen >= SEND_MIN && (millis() - lastPostMs) >= SEND_IDLE_MS) return true;
  return false;
}

static void connectWifi() {
  Serial.printf("WiFi: %s に接続中...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("WiFi: 接続OK ip=%s rssi=%d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  } else {
    Serial.println("WiFi: 接続失敗(ループ内で再試行)");
  }
}

// 起動時に kuda への疎通確認(GET /status)。
static void checkPipe() {
  if (WiFi.status() != WL_CONNECTED) return;
  WiFiClientSecure client;
  makeSecure(client);
  HTTPClient http;
  String url = String(PIPE_URL) + "/status";
  if (http.begin(client, url)) {
    int code = http.GET();
    if (code == 200) {
      String body = http.getString();
      Serial.printf("kuda /status -> 200: %s\n", body.c_str());
    } else {
      Serial.printf("kuda /status -> %d\n", code);
    }
    http.end();
  } else {
    Serial.println("kuda /status: http.begin 失敗");
  }
}

static void printStatusLine() {
  const char *wifi = (WiFi.status() == WL_CONNECTED) ? "OK" : "DOWN";
  if (lastPostCode == 0) {
    Serial.printf("CPM=%u events_total=%lu queue=%uB wifi=%s last_post=--%s\n",
                  currentCPM(), (unsigned long)eventsTotal, sendQueueLen, wifi,
                  queueFull ? " [QUEUE FULL]" : "");
  } else {
    uint32_t ago = (millis() - lastPostMs) / 1000;
    Serial.printf("CPM=%u events_total=%lu queue=%uB wifi=%s last_post=%d(%lus ago)%s\n",
                  currentCPM(), (unsigned long)eventsTotal, sendQueueLen, wifi,
                  lastPostCode, (unsigned long)ago,
                  queueFull ? " [QUEUE FULL]" : "");
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.printf("=== 乱数の管・第二源泉 geiger firmware (source=%s) ===\n", SOURCE);

  pinMode(GPIO_LED, OUTPUT);
  digitalWrite(GPIO_LED, LOW);
  for (int i = 0; i < 60; i++) cpmBuckets[i] = 0;
  lastBucketSec = millis() / 1000;

#if TEST_MODE
  Serial.printf("TEST_MODE: 擬似ポアソン %dCPM で駆動(ガイガー未接続でも動作)\n", TEST_CPM);
  nextTestMicros = micros();
#else
  pinMode(GPIO_PULSE, INPUT_PULLUP);  // 負論理・通常High
  attachInterrupt(digitalPinToInterrupt(GPIO_PULSE), onPulseISR, FALLING);
  Serial.printf("GPIO%d の立ち下がりでパルス検出\n", GPIO_PULSE);
#endif

  connectWifi();
  checkPipe();
  lastPostMs = millis();  // 10分アイドルタイマの起点
}

void loop() {
#if TEST_MODE
  injectTestPulses();
#endif
  processPulses();

  // LED 消灯
  if (ledOffAtMs && (int32_t)(millis() - ledOffAtMs) >= 0) {
    digitalWrite(GPIO_LED, LOW);
    ledOffAtMs = 0;
  }

  // WiFi 再接続(切れていたら蓄積は続き、復帰後に送信)
  static uint32_t lastWifiTry = 0;
  if (WiFi.status() != WL_CONNECTED && millis() - lastWifiTry > 10000) {
    lastWifiTry = millis();
    WiFi.reconnect();
  }

  // 送信(200 のときだけキューをクリア=二重投入しない)
  if (WiFi.status() == WL_CONNECTED && shouldSend() && millis() >= nextAttemptMs) {
    if (postIngest()) {
      sendQueueLen = 0;
      queueFull = false;
      lastPostMs = millis();
      backoffMs = BACKOFF_MIN;
      nextAttemptMs = 0;
    } else {
      nextAttemptMs = millis() + backoffMs;
      backoffMs = (backoffMs * 2 > BACKOFF_MAX) ? BACKOFF_MAX : backoffMs * 2;
      Serial.printf("[WARN] 送信失敗。%lus 後に再試行\n", (unsigned long)(backoffMs / 1000));
    }
  }

  // 10秒ごとにステータス1行
  static uint32_t lastStatus = 0;
  if (millis() - lastStatus >= 10000) {
    lastStatus = millis();
    printStatusLine();
  }
}
