# CLAUDE.md — kuda（乱数の管）作業ルール

このリポジトリで作業する際の規定ルール。将来のセッションでも従うこと。

## プロジェクト概要

物理ゆらぎ（ANU QRNG、将来はガイガー管+ESP32）を Cloudflare Worker の
プールに溜め、`/drop` で1バイトずつアトミックに払い出すエントロピー配管。
本番: `https://kuda.kojiran.workers.dev`（`/drop` `/status` `/refill` `/ingest`）。

## 開発・PR・マージの規定ルール（重要）

1. **開発ブランチは `claude/esp32-api-version-rcx3x3`**。マージ済みなら
   `git checkout -B claude/esp32-api-version-rcx3x3 origin/main` で最新main から切り直す。
2. すべての変更は **PR** にする。
3. **第三者レビュー → マージ**:
   - PR を作ったら、**サブエージェントを起動して第三者視点の独立レビュー**を行う
     （自己レビューで済ませない。フレッシュで批判的な視点で欠陥を探す）。
   - レビューが **APPROVE** なら **自分でマージする**（`merge` method）。
     URL を貼って待つのではなく、レビュー通過後は自分でマージしてよい（規定ルール）。
   - **REQUEST_CHANGES** なら直してから再レビュー。ブロッカーが消えるまでマージしない。
4. **ブランチ削除**: リモートブランチ削除はこの実行環境のネットワークポリシーで
   403 拒否される（できない）。マージ後にローカルブランチだけ削除し、
   リモートは GitHub UI か「Automatically delete head branches」設定に任せる。
5. PR を勝手に作らない指示・機密を貼らない等、既存のガードは引き続き守る。

## パッケージマネージャ: pnpm

- `pnpm install` / `pnpm run typecheck` / `pnpm run dev` / `pnpm run deploy`
  （`deploy` は pnpm 予約語なので必ず `pnpm run deploy`）。
- PR 前に最低限 **`pnpm run typecheck`** を通す。ランタイムに関わる変更は
  `pnpm exec wrangler dev` で実挙動も確認する。
- `pnpm.onlyBuiltDependencies` は `esbuild` / `workerd` のみ許可（他の postinstall は遮断）。

## サプライチェーン対策

- **7日 cooldown**: `.npmrc` の `minimum-release-age=10080`（分）＋
  `.github/dependabot.yml` の `cooldown.default-days: 7`。CVE 修正は cooldown 免除。
- lockfile（`pnpm-lock.yaml`）で整合性を担保。`package-lock.json` は使わない。

## 規約

- **`/status` の `version` はデプロイ日付（YYYY-MM-DD）**。`version_metadata`
  バインディングから自動生成（手動更新しない）。デプロイ反映の確認に使う。
- **秘密値（`INGEST_TOKEN` 等）は絶対にコミット・ログ・チャットに出さない**。
  Worker 側は Secret、ローカルは `.dev.vars`（gitignore 済み）。
- cron 補充は認証不要の内部専用パス `/__cron_refill`（外部到達不可）。
  公開 `/refill` `/ingest` はトークン必須のまま。
- cron は日次 `0 3 * * *`（UTC 03:00 = JST 12:00）。

## デプロイ

- Cloudflare Workers Builds が main への push を検出し pnpm で自動デプロイ。
- 反映確認は `/status` の `version`（当日の年月日になっていれば新デプロイ済み）。
- 詳細手順は `docs/cloudflare-setup.md`。
