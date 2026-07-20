# 乱数の管 (kuda)

物理ゆらぎを溜めて、一滴ずつ払い出すエントロピー配管。

真空の量子ゆらぎ(ANU QRNG)と、放射性崩壊(ガイガー管 + ESP32)を源泉として
Cloudflare Worker上のプールに蓄え、`/drop` で1バイトずつアトミックに取り出す。
LLMや人間の「拮抗した選択」を、疑似乱数ではなく物理的な対称性の破れに委ねるための道具。

## 規律 (このプロジェクトの本体)

1. **消費一回性** — popは削除と同時。同じ粒は二度と出ない。
2. **引き直し禁止** — 出た値がどうであれ採用する。使う側の規律だが、監査ログがそれを検証可能にする。
3. **キャッシュは真空ではない** — 全レスポンスは `Cache-Control: no-store`。`drop_seq` は単調増加で、同じ値を二度見たらそれはキャッシュであり、新しいゆらぎではない。
4. **管が空なら空と言う** — プール枯渇時は503。疑似乱数へのサイレントフォールバックは禁忌。
5. **出自の保存** — 全ての粒に源泉ラベル(`anu#` / `home#`)が付き、drops表に全履歴が残る。

## アーキテクチャ

```
[ANU QRNG]──cron(1日1回)──┐
                           ▼
[自宅: ガイガー管]──┐   Cloudflare Worker (Durable Object + SQLite)
        │           │      pool表: 未消費の粒
     [ESP32]──WiFi──┴──▶  drops表: 払い出しの監査ログ
   パルス間隔LSB            │
   → SHA-256               ▼
   → POST /ingest      GET /drop ──▶ 消費者(一滴 = 1バイト)
```

- **第一源泉: ANU QRNG** — オーストラリア国立大の真空ゆらぎ測定。cronがサーバー側で
  定期取得するため、レガシーAPIのクライアント側キャッシュ問題を構造的に回避する。
- **第二源泉: ガイガー管** — CAJOE系キットのパルス出力をESP32のGPIO割り込みで受け、
  崩壊イベント間隔のLSBをSHA-256で白色化して `/ingest` にPOSTする。
  崩壊のタイミングは量子過程であり、予測は原理的に不可能。

## ダッシュボード

`https://<worker>/` にブラウザでアクセスすると、**Nostr(NIP-07拡張: nos2x, Alby等)
でログイン**してAPIキーを発行・管理できる(1人あたりの有効キー数と新規キーの既定
クォータは管理者が設定。初期値は5本・30滴/日)。
発行された平文キーは**その画面で一度しか表示されない**。発行時に「半公開キー(URL利用可)」
を選ぶと `kudaq_` 種のキーになり、`?key=` でも引ける(低リスク用途向け。上記 `/drop` 参照)。

## API

すべてのレスポンスは `Cache-Control: no-store` 付きJSON。

### `GET /drop`
一滴取り出す。**呼ぶたびにプールから1バイトが不可逆に消費される。**

認証には2レーンある(ヘッダとクエリ両方が来たら**ヘッダ優先**):

1. **正規レーン(推奨)**: `Authorization: Bearer kuda_...`。通常キー(`kuda_`)・半公開キー
   (`kudaq_`)のどちらも使える。常用アプリはこちら。
2. **互換レーン**: `?key=kudaq_...`。ヘッダを付けられないクライアント向け。**半公開キー
   (`kudaq_` 種)のみ受理**する。通常キー(`kuda_`)を `?key=` に貼っても 401 で弾く
   (URL 残留の footgun を型で防ぐ)。

任意で `?client_id=<英数32文字>` または `X-Client-Id` を付けると、どのクライアントが
引いたか監査ログに記録される。

```sh
# 正規レーン(推奨)
curl -H "Authorization: Bearer kuda_..." "https://<worker>/drop?client_id=my-app"
# 互換レーン(半公開キーのみ)
curl "https://<worker>/drop?key=kudaq_...&client_id=my-app"
```

**`?key=` を許した根拠(脅威モデル)**: TLS 下ではパスもクエリも暗号化され、経路上で
見えるのは SNI と IP のみ。クエリ方式の実リスクは「端点でのURL残留」に尽き、それを
本プロジェクトでは (a) 呼び出しログ無効化(`observability.logs.invocation_logs: false`)
+ 自前コードは URL をマスクしてしかログしない、(b) 全応答 `Referrer-Policy: no-referrer`、
(c) 全応答 `Cache-Control: no-store` の3点で潰している。漏えい時の最大被害も read-only
の /drop・当該キーの日次クォータ分のみで、台帳に全消費が残り、ワンクリックで無効化できる。
書き込み系(`/ingest`)・管理系(`/api/admin/*`)は**クエリキー不可**(ヘッダ/セッション必須)。

```json
{
  "value": 199,
  "drop_seq": 42,
  "pool_seq": 1337,
  "batch": "anu#2026-07-09T…#a1b2c3d4",
  "drawn_at": "2026-07-09T…",
  "pool_remaining": 511,
  "client_id": "my-app"
}
```

- `value`: 0–255
- `drop_seq`: 単調増加。重複を見たらキャッシュを疑うこと
- `batch`: 粒の出自
- 枯渇時: `503 {"error": "pool empty — 管が空。補充が必要"}`
- クォータ超過時: `429 {"error": "daily quota exceeded", "quota": 30, "used": 30, "resets_at": "…"}`
  (キー単位・UTC日次。既定30滴/日、管理者が変更可能)
- 無効/不明キー: `401`

**移行期間**: 現在 `REQUIRE_API_KEY=0` のため、キー無しでも動作するが
レスポンスに `warning` が付く(匿名は共有の日次上限で保護。既定は `ANON_DAILY_LIMIT`、
管理者が `/api/admin/settings` の `anon_daily_limit` で変更可能)。
移行完了後に `1` へフリップされるとキー必須になる。

### `GET /status`
残量と履歴の概観。**消費しない。** ヘルスチェックはこちらを使う。
`drops_today`(UTC日の消費数)と `version`(デプロイ日付)を含む。

### `GET /api/stats?key_id=<n|all>`
払い出したバイト値の分布と**一様性検定**。`all`(既定)は誰でも、鍵別(`key_id=<n>`)は
本人または管理者のみ(要ログイン)。`{n, histogram[256], chi2, df:255, p_value, sufficient, note}`。

> **注意**: 乱数バイト(0–255)は**一様分布**に従うのが正常で、正規分布ではありません。
> χ²適合度検定(df=255)で一様性を見ます(`p>0.05` なら一様と矛盾しない)。
> 「複数バイトの合計」は中心極限定理で正規に近づきますが、それは別の話です。
> ダッシュボード(`/`)にヒストグラムとして表示されます。

### `POST /refill` (要 `Authorization: Bearer <INGEST_TOKEN>`)
ANUから手動補充。通常はcronが1日1回(1024バイト)自動実行する。

### `POST /ingest` (要 `Authorization: Bearer <INGEST_TOKEN>`)
自宅源泉からの補充。body: `{"bytes": "<base64>", "source": "home"}`。最大64KiB/回。

### `POST /admin/keys` (要 `Authorization: Bearer <INGEST_TOKEN>`・break-glass)
システム鍵(`user_id` なし)の発行。body: `{"label": "project-a", "daily_quota": 100}`。
**平文キーはこの応答で一度だけ返る**(保存されるのはSHA-256のみ)。レガシー案件用 +
Nostr管理者ログインが壊れた際の緊急経路として残している。通常の管理は下記の管理者APIで。

### 管理者API `GET/POST /api/admin/*`
セッションの pubkey が `ADMIN_PUBKEYS`(hex, カンマ区切り)に含まれる場合のみ(それ以外は403)。
- `GET /api/admin/users` — 全ユーザー + 各鍵(本日使用量つき)+ システム鍵
- `GET/POST /api/admin/settings` — 発行ポリシーの取得・変更。項目は
  `max_keys_per_user`(1..1000)/ `default_daily_quota`(0..100000)/
  `anon_daily_limit`(0..1000000)。`default_daily_quota` は**以後の新規発行**に適用
  (既存鍵は各鍵の quota 変更で個別に)。`anon_daily_limit` は移行期間中の匿名共有上限で、
  `wrangler.jsonc` の `ANON_DAILY_LIMIT` を既定値とし、ここで設定すると上書きする
- `POST /api/admin/keys/:id/disable` — 任意の鍵を無効化
- `POST /api/admin/keys/:id/quota` — `{"daily_quota": n}` で任意の鍵のクォータ変更
- `POST /api/admin/users/:id/ban` / `unban` — ユーザーの ban 切替(ban で当人の全鍵が401/403)

ダッシュボード(`/`)に管理者としてログインすると「管理者」セクションが出る。
管理者pubkey は **ダッシュボードで Secret `ADMIN_PUBKEYS`**(hex, カンマ区切り)として
設定する(`npx wrangler secret put ADMIN_PUBKEYS`)。pubkey は公開情報だが Secret に置く
理由は、`wrangler.jsonc` の `vars` に書くと `deploy` がダッシュボードの値を上書きで
消すのに対し、**Secret はデプロイで上書きされず repo にも残らない**ため。

## デプロイ

```sh
pnpm install
pnpm exec wrangler secret put INGEST_TOKEN   # 補充用トークンを設定
pnpm run deploy
```

- SQLite-backed Durable Objectを使用(無料プランで動作)。
- cronトリガー(1日1回のANU補充)は `wrangler.jsonc` の `triggers.crons` で設定済み。
- デプロイ後、`POST /refill` を一度手で叩いてANUのレスポンス形式とレート制限の
  挙動を確認すること(レガシーAPIは仕様が変わることがある)。

アカウント準備・認証・secret登録・初回シードまでの詳細な手順は
[docs/cloudflare-setup.md](docs/cloudflare-setup.md) を参照。

## ESP32 (第二源泉) のセットアップ

配線は3本。ブレッドボード不要、メス-メスのジャンパで直結できる。

| ガイガーキット | ESP32 |
|---|---|
| VIN (パルス出力) | GPIO (例: 4) |
| GND | GND |
| 5V | 5V (VUSB) |

パルスは3V負論理なのでレベル変換不要。ファームウェアは
WiFi設定・Worker URL・INGEST_TOKENを書き換えて焼く。
動作確認は線源なしのバックグラウンド(20〜30CPM程度)でよい。
ビットレートを上げたい場合はウランガラス等の微弱線源を管に近づける。

## 運用の注意

- **INGEST_TOKENを共有しない・チャットやログに貼らない。**
  管に混ぜ物をされたら、出自の保証がすべて崩れる。
- 公開してよいのは `/drop` と `/status` のURLのみ。
- 監査: drops表に全払い出しが残るため、蓄積後にχ²検定等で一様性を確認できる。
  分布からの逸脱を見つけたら、疑う順番は ①ハードの故障 ②抽出器のバイアス ③宇宙。

## このプロジェクトが答えない問い

なぜその値が出たのか。
