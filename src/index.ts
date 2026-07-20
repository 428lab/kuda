// 乱数の管 — Cloudflare Worker entropy pool
// 第一段階: ANU QRNG(真空の量子ゆらぎ)をcronでサーバー側取得してプールに溜める。
// 第二段階: 自宅/四谷ラボの物理雑音源から /ingest で補充(ESP32ガイガー)。
// どちらの粒も /drop で一滴ずつアトミックに払い出す。
//
// このファイルは Worker エントリ(ルーティング/DO転送/cron)のみ。
// 本体ロジックは src/pool.ts (EntropyPool DO)、共通処理は src/util.ts。

import { json } from "./util";
export { EntropyPool } from "./pool";

// 公開APIのパス。Worker の fetch はこれ以外を DO へ転送しない
// (cron専用の内部パスを外部から叩かせないため)。
// /admin/keys は暫定管理エンドポイント(INGEST_TOKEN必須。PR-5でNostr管理者に置換)。
const PUBLIC_PATHS = new Set(["/drop", "/status", "/refill", "/ingest", "/admin/keys"]);

export interface Env {
  POOL: DurableObjectNamespace;
  INGEST_TOKEN: string; // wrangler secret put INGEST_TOKEN
  ANU_API_URL?: string; // QRNGエンドポイント (default: pool.ts の DEFAULT_ANU_API_URL)
  ANU_REFILL_LENGTH?: string; // cron一回あたりの取得バイト数 (default: 1)
  REQUIRE_API_KEY?: string; // "1" で /drop にAPIキー必須(移行完了後にフリップ)
  ANON_DAILY_LIMIT?: string; // 移行期間中の匿名アクセス共有日次上限 (default: 200)
  CF_VERSION_METADATA?: WorkerVersionMetadata; // デプロイ日時(timestamp)等。version_metadata バインディング
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
