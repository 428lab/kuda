// EntropyPool — 乱数の管の本体 (SQLite-backed Durable Object)。
//
// 規律の実装:
//   - 消費一回性: pop = SELECT + DELETE を同一DO内で実行。同じ粒は二度と出ない
//   - キャッシュ検出: 単調増加 drop_seq を返す。同じseqを二度見たらキャッシュ
//     (ANUレガシーAPIのキャッシュ問題は、Worker側取得+プール消費で構造的に無効化)
//   - 枯渇時は503。疑似乱数へのフォールバックはしない(管が空なら空と言う)
//   - 全ドロップは drops 表に監査ログとして残る(粒の出自 source も記録)

import type { Env } from "./index";
import { json, timingSafeEqual } from "./util";
import {
  API_KEY_PREFIX,
  generateApiKey,
  nextUtcMidnightIso,
  sanitizeClientId,
  sha256Hex,
  utcDayStartIso,
} from "./auth";

// ANU QRNG エンドポイントの既定値。wrangler.jsonc の vars で上書き可能。
const DEFAULT_ANU_API_URL = "https://qrng.anu.edu.au/API/jsonI.php";
const DEFAULT_ANU_REFILL_LENGTH = 1;

// env から ANU リクエストURLを組み立てる。type=uint8 は固定(0-255の粒)。
function anuUrl(env: Env): string {
  const base = env.ANU_API_URL || DEFAULT_ANU_API_URL;
  const parsed = Number(env.ANU_REFILL_LENGTH);
  const length =
    Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_ANU_REFILL_LENGTH;
  return `${base}?length=${length}&type=uint8`;
}

export class EntropyPool {
  private sql: SqlStorage;

  constructor(state: DurableObjectState, private env: Env) {
    this.sql = state.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pool (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        byte        INTEGER NOT NULL CHECK (byte BETWEEN 0 AND 255),
        batch       TEXT    NOT NULL,
        ingested_at TEXT    NOT NULL
      );
      CREATE TABLE IF NOT EXISTS drops (
        drop_seq  INTEGER PRIMARY KEY AUTOINCREMENT,
        pool_seq  INTEGER NOT NULL,
        byte      INTEGER NOT NULL,
        batch     TEXT    NOT NULL DEFAULT '',
        drawn_at  TEXT    NOT NULL
      );
    `);
    // 規律#5(出自の保存): 既存DBの drops に batch 列がなければ追加する。
    // pool 行は pop時に削除されるので、出自は drops 側に写しておかないと失われる。
    // key_id / client_id も同じ冪等ALTERパターン(稼働中DBへの追加のみ・DROP禁止)。
    const dropCols = new Set(
      this.sql
        .exec<{ name: string }>("PRAGMA table_info(drops)")
        .toArray()
        .map((c) => c.name)
    );
    if (!dropCols.has("batch")) {
      this.sql.exec("ALTER TABLE drops ADD COLUMN batch TEXT NOT NULL DEFAULT ''");
    }
    if (!dropCols.has("key_id")) {
      // NULL = 認証なし(レガシー/匿名)のドロップ
      this.sql.exec("ALTER TABLE drops ADD COLUMN key_id INTEGER");
    }
    if (!dropCols.has("client_id")) {
      this.sql.exec("ALTER TABLE drops ADD COLUMN client_id TEXT NOT NULL DEFAULT ''");
    }

    // APIキー基盤(認証導入計画 PR-2)。users は PR-3 のログイン導入で本格利用。
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id    INTEGER PRIMARY KEY AUTOINCREMENT,
        pubkey     TEXT NOT NULL UNIQUE,
        provider   TEXT NOT NULL DEFAULT 'nostr',
        created_at TEXT NOT NULL,
        banned_at  TEXT
      );
      CREATE TABLE IF NOT EXISTS api_keys (
        key_id      INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER,
        key_hash    TEXT NOT NULL UNIQUE,
        key_prefix  TEXT NOT NULL,
        label       TEXT NOT NULL DEFAULT '',
        daily_quota INTEGER NOT NULL DEFAULT 30,
        created_at  TEXT NOT NULL,
        disabled_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_drops_key_day ON drops(key_id, drawn_at);
    `);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "POST" && url.pathname === "/ingest") return await this.ingest(req);
      if (req.method === "POST" && url.pathname === "/refill") return await this.refillFromAnu(req);
      // cron専用: 内部からのみ到達(Worker fetch が転送しない)。認証不要。
      if (req.method === "POST" && url.pathname === "/__cron_refill") return await this.refillFromAnu(req, true);
      // 暫定管理: ダッシュボード(PR-3以降)完成前にレガシー案件へ鍵を配る橋。PR-5で置換。
      if (req.method === "POST" && url.pathname === "/admin/keys") return await this.adminCreateKey(req);
      if (req.method === "GET" && url.pathname === "/drop") return await this.drop(req, url);
      if (req.method === "GET" && url.pathname === "/status") return this.status(req);
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  private authorized(req: Request): boolean {
    const auth = req.headers.get("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    return !!this.env.INGEST_TOKEN && timingSafeEqual(token, this.env.INGEST_TOKEN);
  }

  // POST /refill — ANU QRNGからサーバー側で取得してプールへ(第一段階の補充経路)
  // 外部から叩く場合は要トークン。cron からは internal=true で認証を省く
  // (自分自身の呼び出しであり、/__cron_refill は外部到達不可のため)。
  private async refillFromAnu(req: Request, internal = false): Promise<Response> {
    if (!internal && !this.authorized(req)) return json({ error: "unauthorized" }, 401);

    const res = await fetch(anuUrl(this.env), {
      headers: { "Cache-Control": "no-cache" },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!res.ok) {
      console.error(`ANU API error: ${res.status}`);
      return json({ error: `ANU API ${res.status}`, pool_remaining: this.poolCount() }, 502);
    }
    const body = (await res.json()) as { success?: boolean; data?: number[] };
    if (!body.success || !body.data?.length) {
      console.error(`ANU API returned no data: ${JSON.stringify(body)}`);
      return json({ error: "ANU API returned no data", raw: body }, 502);
    }

    const now = new Date().toISOString();
    const batch = `anu#${now}#${crypto.randomUUID().slice(0, 8)}`;
    for (const b of body.data) {
      if (b < 0 || b > 255) continue;
      this.sql.exec(
        "INSERT INTO pool (byte, batch, ingested_at) VALUES (?, ?, ?)",
        b, batch, now
      );
    }
    return json({ ok: true, source: "anu", ingested: body.data.length,
                  pool_remaining: this.poolCount() });
  }

  // POST /ingest  Authorization: Bearer <INGEST_TOKEN>
  // body: { "bytes": "<base64>", "source": "home" }  最大 64KiB/回 (第二段階の補充経路)
  private async ingest(req: Request): Promise<Response> {
    if (!this.authorized(req)) return json({ error: "unauthorized" }, 401);

    const body = (await req.json()) as { bytes?: string; source?: string };
    if (!body.bytes) return json({ error: "missing 'bytes' (base64)" }, 400);

    let raw: Uint8Array;
    try {
      const bin = atob(body.bytes);
      raw = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    } catch {
      return json({ error: "invalid base64" }, 400);
    }
    if (raw.length === 0) return json({ error: "empty payload" }, 400);
    if (raw.length > 65536) return json({ error: "payload too large (max 64KiB)" }, 413);

    const now = new Date().toISOString();
    const source = (body.source ?? "home").replace(/[^a-z0-9_-]/gi, "").slice(0, 16) || "home";
    const batch = `${source}#${now}#${crypto.randomUUID().slice(0, 8)}`;
    for (const b of raw) {
      this.sql.exec(
        "INSERT INTO pool (byte, batch, ingested_at) VALUES (?, ?, ?)",
        b, batch, now
      );
    }
    const remaining = this.poolCount();
    return json({ ok: true, ingested: raw.length, batch, pool_remaining: remaining });
  }

  // key_id(または匿名=NULL)の当日UTC消費数
  private usedToday(keyId: number | null): number {
    const since = utcDayStartIso();
    const row = keyId === null
      ? this.sql.exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM drops WHERE key_id IS NULL AND drawn_at >= ?", since)
      : this.sql.exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM drops WHERE key_id = ? AND drawn_at >= ?", keyId, since);
    return row.toArray()[0].n;
  }

  // GET /drop — 一滴。FIFOでpop、削除、監査ログへ。
  // 認証: Authorization: Bearer kuda_...(APIキー)。移行期間中(REQUIRE_API_KEY=0)は
  // キー無しも許可するが warning を返し、匿名共有の日次上限で保護する。
  private async drop(req: Request, url: URL): Promise<Response> {
    const auth = req.headers.get("Authorization") ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const requireKey = this.env.REQUIRE_API_KEY === "1";
    const anonLimitParsed = Number(this.env.ANON_DAILY_LIMIT);
    const anonLimit = Number.isFinite(anonLimitParsed) && anonLimitParsed >= 0
      ? Math.floor(anonLimitParsed) : 200;

    let keyId: number | null = null;
    let warning: string | undefined;

    if (bearer) {
      // キーを明示したリクエストは匿名にフォールバックさせない(誤設定の隠蔽防止)
      if (!bearer.startsWith(API_KEY_PREFIX)) {
        return json({ error: "invalid API key" }, 401);
      }
      const hash = await sha256Hex(bearer);
      const key = this.sql
        .exec<{ key_id: number; user_id: number | null; daily_quota: number; disabled_at: string | null }>(
          "SELECT key_id, user_id, daily_quota, disabled_at FROM api_keys WHERE key_hash = ?", hash)
        .toArray()[0];
      if (!key) return json({ error: "invalid API key" }, 401);
      if (key.disabled_at) return json({ error: "API key disabled" }, 401);
      if (key.user_id !== null) {
        const banned = this.sql
          .exec<{ banned_at: string | null }>(
            "SELECT banned_at FROM users WHERE user_id = ?", key.user_id)
          .toArray()[0];
        if (banned?.banned_at) return json({ error: "account banned" }, 403);
      }
      const used = this.usedToday(key.key_id);
      if (used >= key.daily_quota) {
        return json({
          error: "daily quota exceeded",
          quota: key.daily_quota,
          used,
          resets_at: nextUtcMidnightIso(),
        }, 429);
      }
      keyId = key.key_id;
    } else {
      if (requireKey) {
        return json({
          error: "API key required",
          hint: "Authorization: Bearer kuda_... を付けてください。キーはダッシュボードで発行できます",
        }, 401);
      }
      // 移行期間: 匿名は共有の日次上限で保護(イベント直後の枯渇対策)
      const anonUsed = this.usedToday(null);
      if (anonUsed >= anonLimit) {
        return json({
          error: "anonymous daily limit exceeded",
          limit: anonLimit,
          resets_at: nextUtcMidnightIso(),
          hint: "APIキーを取得するとキー単位のクォータで利用できます",
        }, 429);
      }
      warning = "認証なしアクセスは廃止予定。APIキーを取得してください";
    }

    const clientId = sanitizeClientId(
      url.searchParams.get("client_id") ?? req.headers.get("X-Client-Id")
    );

    const row = this.sql
      .exec<{ seq: number; byte: number; batch: string }>(
        "SELECT seq, byte, batch FROM pool ORDER BY seq LIMIT 1"
      )
      .toArray()[0];

    if (!row) {
      return json({ error: "pool empty — 管が空。補充が必要", pool_remaining: 0 }, 503);
    }

    const now = new Date().toISOString();
    this.sql.exec("DELETE FROM pool WHERE seq = ?", row.seq);
    this.sql.exec(
      "INSERT INTO drops (pool_seq, byte, batch, drawn_at, key_id, client_id) VALUES (?, ?, ?, ?, ?, ?)",
      row.seq, row.byte, row.batch, now, keyId, clientId
    );
    const dropSeq = this.sql
      .exec<{ s: number }>("SELECT MAX(drop_seq) AS s FROM drops")
      .toArray()[0].s;

    return json({
      value: row.byte,          // 0-255
      drop_seq: dropSeq,        // 単調増加。重複が見えたらキャッシュを疑え
      pool_seq: row.seq,
      batch: row.batch,         // 粒の出自 (anu#... / home#...)
      drawn_at: now,
      pool_remaining: this.poolCount(),
      ...(clientId ? { client_id: clientId } : {}),
      ...(warning ? { warning } : {}),
    });
  }

  // POST /admin/keys  Authorization: Bearer <INGEST_TOKEN>(暫定・PR-5でNostr管理者に置換)
  // body: { "label": "project-a", "daily_quota": 100 } → 平文キーは一度だけ返す
  private async adminCreateKey(req: Request): Promise<Response> {
    if (!this.authorized(req)) return json({ error: "unauthorized" }, 401);

    const body = (await req.json().catch(() => ({}))) as { label?: string; daily_quota?: number };
    const label = String(body.label ?? "").replace(/[^\w\s.-]/g, "").slice(0, 64);
    const quotaParsed = Number(body.daily_quota);
    const dailyQuota = Number.isFinite(quotaParsed) && quotaParsed >= 1 && quotaParsed <= 100000
      ? Math.floor(quotaParsed) : 30;

    const { plaintext, prefix } = generateApiKey();
    const hash = await sha256Hex(plaintext);
    const now = new Date().toISOString();
    this.sql.exec(
      "INSERT INTO api_keys (user_id, key_hash, key_prefix, label, daily_quota, created_at) VALUES (NULL, ?, ?, ?, ?, ?)",
      hash, prefix, label, dailyQuota, now
    );
    const keyId = this.sql
      .exec<{ id: number }>("SELECT last_insert_rowid() AS id")
      .toArray()[0].id;

    return json({
      key: plaintext,           // ← 保存されない。この応答でのみ取得可能
      key_id: keyId,
      key_prefix: prefix,
      label,
      daily_quota: dailyQuota,
      note: "この平文キーは二度と表示されません。安全に保管してください",
    });
  }

  // GET /status — 残量と履歴の概観(消費しない)
  private status(req: Request): Response {
    const drops = this.sql
      .exec<{ n: number; last: string | null }>(
        "SELECT COUNT(*) AS n, MAX(drawn_at) AS last FROM drops"
      )
      .toArray()[0];
    const lastIngest = this.sql
      .exec<{ t: string | null }>("SELECT MAX(ingested_at) AS t FROM pool")
      .toArray()[0].t;
    const dropsToday = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM drops WHERE drawn_at >= ?", utcDayStartIso())
      .toArray()[0].n;

    return json({
      // デプロイ日付(YYYY-MM-DD)。Worker がヘッダで渡す値を優先し、無ければ
      // DO の env、それも無ければ "dev"。ISO日時から日付部分だけ取り出す。
      version: (req.headers.get("X-Deploy-Version")
        || this.env.CF_VERSION_METADATA?.timestamp || "dev").split("T")[0],
      pool_remaining: this.poolCount(),
      total_drops: drops.n,
      drops_today: dropsToday,  // 消費ペース監視用(UTC日)
      last_drop_at: drops.last,
      last_ingest_at: lastIngest,
    });
  }

  private poolCount(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pool").toArray()[0].n;
  }
}
