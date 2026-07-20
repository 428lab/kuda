import { defineConfig } from "vitest/config";

// 純関数ユニット(nostr/auth/util/stats)を Node 環境で実行する。
// これらは @noble(純JS)と Node 22 のグローバル Web Crypto
// (crypto.subtle / getRandomValues / btoa / atob / TextEncoder)だけで動くため、
// workerd は不要。DO(SQLite)を跨ぐ統合検証は test/e2e.mjs(wrangler dev 相手)で行う。
//
// 補足: DO統合を in-process で回す @cloudflare/vitest-pool-workers は、wrangler 3系の
// 最終ライン(0.7.8)が SQLite-backed DO のテストストレージで落ちるため今は不採用。
// wrangler 4 へ上げる際に再検討する。
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
