# Cloudflare セットアップ手順

乱数の管 (rng-pipe) を Cloudflare Workers にデプロイする手順。
コードと `wrangler.jsonc` はデプロイ可能な状態になっているので、
やることは **アカウント準備 → 認証 → secret投入 → deploy → 初回シード** の流れ。

## 前提

- Node.js 18+ とローカルのシェル
- Cloudflare アカウント(**無料プランでOK**)

このWorkerは **SQLite-backed Durable Objects** を使う(`wrangler.jsonc` の
`migrations.new_sqlite_classes` で設定済み)。これは Workers 無料プランで動作する。
万一デプロイ時に課金プランを要求された場合のみ Workers Paid ($5/月) が必要になる。

## 1. アカウント準備(ダッシュボード、一度きり)

1. https://dash.cloudflare.com でアカウント作成(無料)。
2. **workers.dev サブドメイン** は初回 `wrangler deploy` 時に自動で登録を求められる。
   例: `rng-pipe.<あなたのサブドメイン>.workers.dev` が払い出される。

## 2. 認証(ローカルCLI)

```sh
cd kuda
npm install
npx wrangler login      # ブラウザが開いて認可
```

CI等でブラウザが使えない場合は、代わりに API トークンを環境変数で渡す:

```sh
export CLOUDFLARE_API_TOKEN=<Workers 編集権限のトークン>
# 複数アカウントを持つ場合は account_id の指定も必要:
export CLOUDFLARE_ACCOUNT_ID=<アカウントID>
```

> API トークンは https://dash.cloudflare.com/profile/api-tokens で
> "Edit Cloudflare Workers" テンプレートから作成できる。

## 3. INGEST_TOKEN(補充用シークレット)を登録

`/refill` と `/ingest` の Bearer 認証に使う。**長いランダム値**を生成して登録する。

```sh
openssl rand -hex 32                 # ← 出力をコピー
npx wrangler secret put INGEST_TOKEN # ← プロンプトに貼り付け
```

- この値は Worker 側 (secret) と、補充スクリプト `scripts/replenish.py` の
  環境変数 `INGEST_TOKEN` で**同じ値**を使う。
- **チャットやログ・コミットに絶対に貼らない。** 漏れると管に混ぜ物ができてしまい、
  出自の保証が崩れる。リポジトリには含めないこと(`.dev.vars` は `.gitignore` 済み)。

## 4. デプロイ

```sh
npx wrangler deploy
```

- Durable Object バインディング (`POOL`) と SQLite マイグレーション (`v1`) が適用される。
- cron トリガー(`wrangler.jsonc` の `triggers.crons`、既定 30分毎)も自動で有効化される。

## 5. 初回シード & 動作確認

デプロイ直後はプールが空(=`/drop` が 503)。一度手で補充してから確認する。

```sh
TOKEN=<3で登録したトークン>
URL=https://rng-pipe.<あなたのサブドメイン>.workers.dev

# ANU から補充(通常は cron が30分毎に自動でやる)
curl -X POST $URL/refill -H "Authorization: Bearer $TOKEN"

# 残量確認(消費しない)
curl $URL/status

# 一滴取り出す(消費する)
curl $URL/drop
```

デプロイ後に一度手で `/refill` を叩き、ANU のレスポンス形式とレート制限の挙動を
確認しておくこと(レガシーAPIは仕様が変わることがある)。

## 設定のカスタマイズ

`wrangler.jsonc` の値で調整する。

| 項目 | 場所 | 既定 | 説明 |
|------|------|------|------|
| cron 間隔 | `triggers.crons` | `*/30 * * * *`(30分毎) | ANU自動補充の頻度 |
| 1回の取得量 | `vars.ANU_REFILL_LENGTH` | `1` | cron一回あたりの取得バイト数 |
| ANUエンドポイント | `vars.ANU_API_URL` | `https://qrng.anu.edu.au/API/jsonI.php` | QRNG API |

> 30分毎 × 1バイトだと 1時間で2バイトしか貯まらない。消費ペースに合わせて
> `ANU_REFILL_LENGTH` を増やす(例 `10`〜`100`)か、cron間隔を縮めること。
> ANU のレート制限には注意。

秘密値(`INGEST_TOKEN`)は `vars` ではなく **secret** で管理する(手順3)。
ローカル開発では `.dev.vars` に置く(`cp .dev.vars.example .dev.vars`、gitignore済み)。

## ローカルで試す(デプロイ前)

```sh
cp .dev.vars.example .dev.vars   # INGEST_TOKEN を入れる
npm run dev                      # http://127.0.0.1:8787 で起動
```

## トラブルシューティング

| 症状 | 原因 / 対処 |
|------|-------------|
| `/drop` が常に503 | プールが空。`/refill` で補充、または cron の発火を待つ |
| `/refill` が 401 | `INGEST_TOKEN` 未登録 or Bearer トークン不一致 |
| `/refill` が 502 | ANU API 側のエラー。時間をおいて再試行(レート制限の可能性) |
| デプロイで課金を要求される | アカウントの状態によっては Workers Paid が必要。まず無料で試す |
| `binding POOL not found` 等 | `wrangler.jsonc` の `durable_objects` / `migrations` を確認 |
