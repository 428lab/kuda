// 乱数の管 — Cloudflare Worker entropy pool
// 第一段階: ANU QRNG(真空の量子ゆらぎ)をcronでサーバー側取得してプールに溜める。
// 第二段階: 自宅/四谷ラボの物理雑音源から /ingest で補充(将来)。
// どちらの粒も /drop で一滴ずつアトミックに払い出す。
//
// 規律の実装:
//   - 消費一回性: pop = SELECT + DELETE を同一DO内で実行。同じ粒は二度と出ない
//   - キャッシュ検出: 単調増加 drop_seq を返す。同じseqを二度見たらキャッシュ
//     (ANUレガシーAPIのキャッシュ問題は、Worker側取得+プール消費で構造的に無効化)
//   - 枯渇時は503。疑似乱数へのフォールバックはしない(管が空なら空と言う)
//   - 全ドロップは drops 表に監査ログとして残る(粒の出自 source も記録)

// ANU QRNG エンドポイントの既定値。wrangler.jsonc の vars で上書き可能。
const DEFAULT_ANU_API_URL = "https://qrng.anu.edu.au/API/jsonI.php";
const DEFAULT_ANU_REFILL_LENGTH = 1;

// 公開APIのパス。Worker の fetch はこれ以外を DO へ転送しない
// (cron専用の内部パスを外部から叩かせないため)。
const PUBLIC_PATHS = new Set(["/drop", "/status", "/refill", "/ingest"]);

export interface Env {
  POOL: DurableObjectNamespace;
  INGEST_TOKEN: string; // wrangler secret put INGEST_TOKEN
  ANU_API_URL?: string; // QRNGエンドポイント (default: DEFAULT_ANU_API_URL)
  ANU_REFILL_LENGTH?: string; // cron一回あたりの取得バイト数 (default: 1)
  CF_VERSION_METADATA?: WorkerVersionMetadata; // デプロイ日時(timestamp)等。version_metadata バインディング
}

// env から ANU リクエストURLを組み立てる。type=uint8 は固定(0-255の粒)。
function anuUrl(env: Env): string {
  const base = env.ANU_API_URL || DEFAULT_ANU_API_URL;
  const parsed = Number(env.ANU_REFILL_LENGTH);
  const length =
    Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_ANU_REFILL_LENGTH;
  return `${base}?length=${length}&type=uint8`;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // 公開パスのみ DO へ転送。未知パス(cron専用の内部パス含む)は 404。
    const url = new URL(req.url);
    if (!PUBLIC_PATHS.has(url.pathname)) return json({ error: "not found" }, 404);
    const stub = env.POOL.get(env.POOL.idFromName("main"));
    // /status はデプロイ日時を返す。version_metadata は Worker の env で確実に
    // 取れるので、ヘッダで DO へ渡す(DOのenvに伝播しないケースへの保険)。
    if (url.pathname === "/status") {
      const headers = new Headers(req.headers);
      headers.set("X-Deploy-Version", env.CF_VERSION_METADATA?.timestamp || "dev");
      return stub.fetch(new Request(url.toString(), { method: "GET", headers }));
    }
    return stub.fetch(req);
  },

  // cron (wrangler.jsonc の triggers) — ANUから定期的に一滴取ってプールへ。
  // 内部からの自己呼び出しなので認証は不要。cron専用パス /__cron_refill を叩く。
  // このパスは公開 fetch から転送されないため外部からは到達できない。
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const id = env.POOL.idFromName("main");
    const res = await env.POOL.get(id).fetch(
      new Request("https://internal/__cron_refill", { method: "POST" })
    );
    if (!res.ok) {
      console.error(`cron refill failed: ${res.status} ${await res.text()}`);
    }
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // 真空はキャッシュしない
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
    },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
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
    const hasBatch = this.sql
      .exec<{ name: string }>("PRAGMA table_info(drops)")
      .toArray()
      .some((c) => c.name === "batch");
    if (!hasBatch) {
      this.sql.exec("ALTER TABLE drops ADD COLUMN batch TEXT NOT NULL DEFAULT ''");
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "POST" && url.pathname === "/ingest") return await this.ingest(req);
      if (req.method === "POST" && url.pathname === "/refill") return await this.refillFromAnu(req);
      // cron専用: 内部からのみ到達(Worker fetch が転送しない)。認証不要。
      if (req.method === "POST" && url.pathname === "/__cron_refill") return await this.refillFromAnu(req, true);
      if (req.method === "GET" && url.pathname === "/drop") return this.drop();
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

  // GET /drop — 一滴。FIFOでpop、削除、監査ログへ
  private drop(): Response {
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
      "INSERT INTO drops (pool_seq, byte, batch, drawn_at) VALUES (?, ?, ?, ?)",
      row.seq, row.byte, row.batch, now
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

    return json({
      // デプロイ日付(YYYY-MM-DD)。Worker がヘッダで渡す値を優先し、無ければ
      // DO の env、それも無ければ "dev"。ISO日時から日付部分だけ取り出す。
      version: (req.headers.get("X-Deploy-Version")
        || this.env.CF_VERSION_METADATA?.timestamp || "dev").split("T")[0],
      pool_remaining: this.poolCount(),
      total_drops: drops.n,
      last_drop_at: drops.last,
      last_ingest_at: lastIngest,
    });
  }

  private poolCount(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pool").toArray()[0].n;
  }
}
