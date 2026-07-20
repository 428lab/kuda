# テスト

2層構成。**PR前に最低限 `pnpm test`(+ `pnpm run typecheck`)を通す**。

## ユニット(`pnpm test` / CI)

`vitest`(Node環境)で純関数を検証。workerd不要・sub秒。CI(`.github/workflows/test.yml`)で
PRごとに自動実行される。

- `test/nostr.test.ts` — NIP-01 id 計算、schnorr署名検証(合格/各拒否理由)
- `test/auth.test.ts` — セッションCookie(HMAC roundtrip/改ざん/期限切れ)、CSRF、
  sanitize、UTC日境界、APIキー生成
- `test/util.test.ts` — timingSafeEqual / json

## 結合E2E(`pnpm run test:e2e` / 手動)

DO(SQLite)を跨ぐ全経路を、実行中の `wrangler dev` に対して検証する。

```sh
# 端末A(管理者テストも回すなら ADMIN_PUBKEYS に固定テスト鍵の pubkey を入れる)
printf 'INGEST_TOKEN="test-token"\nSESSION_SECRET="test-secret"\nADMIN_PUBKEYS="1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f"\n' > .dev.vars
pnpm dev --local --port 8787
# 端末B(ADMIN_SK を渡すと管理者API(ban/quota/disable)も検証。省略時はスキップ)
BASE=http://127.0.0.1:8787 INGEST_TOKEN=test-token \
  ADMIN_SK=0101010101010101010101010101010101010101010101010101010101010101 \
  pnpm run test:e2e
```

検証内容: /drop の pop一回性・drop_seq単調、クォータ429、不明キー401、
NIP-07 ログイン→鍵発行→認証drop→used_today→無効化→401、challenge再利用/改ざん署名/
期限切れ/CSRF/改ざんCookie の拒否、/__cron_refill 外部404 など。

> DO統合を in-process で回す `@cloudflare/vitest-pool-workers` は、wrangler 3系の
> 最終ライン(0.7.8)が SQLite-backed DO のテストストレージで落ちるため現状不採用。
> wrangler 4 へ上げる際に、このE2Eを vitest-pool-workers の統合テストへ畳むのを再検討。
