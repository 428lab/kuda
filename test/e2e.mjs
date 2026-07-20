// DO統合のE2E — 実行中の `wrangler dev` に対して全経路を検証する。
//
// 使い方(2ターミナル):
//   端末A: INGEST_TOKEN=test-token SESSION_SECRET=test-secret pnpm dev --local --port 8787
//   端末B: BASE=http://127.0.0.1:8787 INGEST_TOKEN=test-token pnpm run test:e2e
//
// なぜ vitest ではないか: DO統合をin-processで回す @cloudflare/vitest-pool-workers は
// wrangler 3系(0.7.8)が SQLite-backed DO のテストストレージで落ちるため。純関数の
// ユニットは `pnpm test`(vitest)側でカバー済み。ここは実バイナリ相手の結合検証。

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

const BASE = (process.env.BASE || "http://127.0.0.1:8787").replace(/\/$/, "");
const INGEST_TOKEN = process.env.INGEST_TOKEN || "test-token";

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => Uint8Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.slice(i * 2, i * 2 + 2), 16));

function signEvent(sk, pk, { kind = 22242, created_at, tags = [], content = "" } = {}) {
  created_at ??= Math.floor(Date.now() / 1000);
  const id = hex(sha256(new TextEncoder().encode(JSON.stringify([0, pk, created_at, kind, tags, content]))));
  return { id, pubkey: pk, created_at, kind, tags, content, sig: hex(schnorr.sign(unhex(id), sk)) };
}

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, headers: res.headers };
}

const results = [];
const check = (name, cond, detail = "") =>
  results.push({ ok: !!cond, line: `${cond ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}` });

async function seed(n = 64) {
  const arr = Uint8Array.from({ length: n }, (_, i) => i & 0xff);
  let bin = ""; for (const b of arr) bin += String.fromCharCode(b);
  const res = await api("/ingest", {
    method: "POST",
    headers: { Authorization: `Bearer ${INGEST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ bytes: btoa(bin), source: "home" }),
  });
  if (res.status !== 200) throw new Error("seed failed: " + res.status + " " + JSON.stringify(res.body));
}

async function makeKey(quota = 30) {
  const res = await api("/admin/keys", {
    method: "POST",
    headers: { Authorization: `Bearer ${INGEST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ label: "e2e", daily_quota: quota }),
  });
  return res.body.key;
}

// ── /drop 規律 ──
await seed(300);
{
  const key = await makeKey(30);
  const seen = new Set(); let last = 0;
  for (let i = 0; i < 10; i++) {
    const d = await api("/drop", { headers: { Authorization: `Bearer ${key}` } });
    if (d.status !== 200) { check("pop一回性", false, "status=" + d.status); break; }
    if (seen.has(d.body.pool_seq)) { check("pop一回性", false, "dup pool_seq"); break; }
    seen.add(d.body.pool_seq);
    if (d.body.drop_seq <= last) { check("drop_seq単調", false); break; }
    last = d.body.drop_seq;
  }
  check("pop一回性・drop_seq単調(10回重複なし)", seen.size === 10);
}
{
  const key = await makeKey(2);
  const h = { Authorization: `Bearer ${key}` };
  const a = await api("/drop", { headers: h });
  const b = await api("/drop", { headers: h });
  const c = await api("/drop", { headers: h });
  check("クォータ(2)超過で429", a.status === 200 && b.status === 200 && c.status === 429, "3rd=" + c.status);
  check("429にquota/used/resets_at", c.body.quota === 2 && c.body.used === 2 && !!c.body.resets_at);
}
check("不明キーは401", (await api("/drop", { headers: { Authorization: "Bearer kuda_" + "0".repeat(64) } })).status === 401);
check("非kuda_キーは401", (await api("/drop", { headers: { Authorization: "Bearer nope" } })).status === 401);
check("/admin/keys 無トークン401", (await api("/admin/keys", { method: "POST", body: "{}" })).status === 401);

// ── NIP-07 ログイン → 鍵 → 認証drop ──
{
  const sk = schnorr.utils.randomSecretKey();
  const pk = hex(schnorr.getPublicKey(sk));
  const ch = await api("/auth/challenge");
  check("challenge発行", ch.status === 200 && ch.body.challenge?.length >= 32);
  const ev = signEvent(sk, pk, { tags: [["challenge", ch.body.challenge]] });
  const jsonH = { "Content-Type": "application/json", "Origin": BASE };
  const login = await api("/auth/nostr", { method: "POST", headers: jsonH, body: JSON.stringify(ev) });
  check("正常ログイン200", login.status === 200 && login.body.ok, JSON.stringify(login.body));
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  check("Set-Cookie HttpOnly", /HttpOnly/i.test(login.headers.get("set-cookie") || ""));
  check("challenge再利用401", (await api("/auth/nostr", { method: "POST", headers: jsonH, body: JSON.stringify(ev) })).status === 401);

  // 改ざん/期限切れ/未知challenge
  const ch2 = await api("/auth/challenge");
  const bad = signEvent(sk, pk, { tags: [["challenge", ch2.body.challenge]] });
  bad.sig = bad.sig.slice(0, -2) + (bad.sig.endsWith("00") ? "01" : "00");
  check("改ざん署名401", (await api("/auth/nostr", { method: "POST", headers: jsonH, body: JSON.stringify(bad) })).status === 401);
  const ch3 = await api("/auth/challenge");
  const old = signEvent(sk, pk, { created_at: Math.floor(Date.now() / 1000) - 1200, tags: [["challenge", ch3.body.challenge]] });
  check("created_at範囲外401", (await api("/auth/nostr", { method: "POST", headers: jsonH, body: JSON.stringify(old) })).status === 401);

  const me = await api("/api/me", { headers: { Cookie: cookie } });
  check("/api/me 200", me.status === 200 && me.body.pubkey === pk);
  check("/api/me 未ログイン401", (await api("/api/me")).status === 401);
  check("CSRFクロスオリジン400", (await api("/api/keys", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example", Cookie: cookie }, body: "{}" })).status === 400);

  const created = await api("/api/keys", { method: "POST", headers: { ...jsonH, Cookie: cookie }, body: JSON.stringify({ label: "e2e <x>" }) });
  check("鍵発行200 + labelサニタイズ", created.status === 200 && created.body.key?.startsWith("kuda_") && !created.body.label.includes("<"));
  const drop = await api("/drop", { headers: { Authorization: `Bearer ${created.body.key}` } });
  check("発行鍵で/drop200", drop.status === 200);
  const me2 = await api("/api/me", { headers: { Cookie: cookie } });
  check("used_today=1", me2.body.keys?.find((k) => k.key_id === created.body.key_id)?.used_today === 1);
  const dis = await api(`/api/keys/${created.body.key_id}/disable`, { method: "POST", headers: { ...jsonH, Cookie: cookie } });
  check("無効化200", dis.status === 200);
  check("無効化後drop401", (await api("/drop", { headers: { Authorization: `Bearer ${created.body.key}` } })).status === 401);
  check("改ざんCookie401", (await api("/api/me", { headers: { Cookie: cookie.slice(0, -4) + "aaaa" } })).status === 401);
}

// ── 統計 /api/stats ──
{
  // これまでの drop で全体統計に n>0 が入っているはず
  const s = await api("/api/stats?key_id=all");
  check("/api/stats all 200", s.status === 200 && Array.isArray(s.body.histogram) && s.body.histogram.length === 256);
  check("/api/stats に chi2/df/p_value/n/note", s.body.df === 255 && "chi2" in s.body && "p_value" in s.body && typeof s.body.n === "number" && !!s.body.note);
  // 鍵別統計は未ログインだと401
  check("鍵別統計は未ログイン401", (await api("/api/stats?key_id=1")).status === 401);
  check("不正key_idは400", (await api("/api/stats?key_id=abc")).status === 400);
}

// ── 管理者API(ADMIN_SK が設定され、サーバの ADMIN_PUBKEYS に対応pubkeyが入っている前提) ──
if (process.env.ADMIN_SK) {
  const skHex = process.env.ADMIN_SK;
  const asdk = unhex(skHex);
  const apk = hex(schnorr.getPublicKey(asdk));
  const jsonH = { "Content-Type": "application/json", "Origin": BASE };
  async function loginAs(sk, pk) {
    const ch = await api("/auth/challenge");
    const ev = signEvent(sk, pk, { tags: [["challenge", ch.body.challenge]] });
    const r = await api("/auth/nostr", { method: "POST", headers: jsonH, body: JSON.stringify(ev) });
    return { cookie: (r.headers.get("set-cookie") || "").split(";")[0], is_admin: r.body.is_admin };
  }

  const admin = await loginAs(asdk, apk);
  check("管理者ログインで is_admin=true", admin.is_admin === true);

  // 一般ユーザーを作る(このユーザーの user_id/鍵を admin が操作する)
  const usk = schnorr.utils.randomSecretKey();
  const upk = hex(schnorr.getPublicKey(usk));
  const user = await loginAs(usk, upk);
  const uk = await api("/api/keys", { method: "POST", headers: { ...jsonH, Cookie: user.cookie }, body: JSON.stringify({ label: "victim" }) });
  const userKey = uk.body.key, userKeyId = uk.body.key_id;

  // 非管理者は /api/admin/* が403
  check("非管理者 /api/admin/users 403", (await api("/api/admin/users", { headers: { Cookie: user.cookie } })).status === 403);
  // 未ログインも403
  check("未ログイン /api/admin/users 403", (await api("/api/admin/users")).status === 403);

  // 管理者は一覧取得
  const list = await api("/api/admin/users", { headers: { Cookie: admin.cookie } });
  check("管理者 /api/admin/users 200", list.status === 200 && Array.isArray(list.body.users));
  const victim = list.body.users.find((u) => u.pubkey === upk);
  check("一覧に対象ユーザーと鍵", !!victim && victim.keys.some((k) => k.key_id === userKeyId));

  // ── 発行ポリシー(settings): 管理者が max_keys_per_user / default_daily_quota を変更 ──
  {
    check("非管理者 settings GET 403", (await api("/api/admin/settings", { headers: { Cookie: user.cookie } })).status === 403);
    const set = await api("/api/admin/settings", { method: "POST", headers: { ...jsonH, Cookie: admin.cookie }, body: JSON.stringify({ max_keys_per_user: 1, default_daily_quota: 7 }) });
    check("管理者 settings POST 200", set.status === 200 && set.body.max_keys_per_user === 1 && set.body.default_daily_quota === 7);
    check("settings GET が反映値", (await api("/api/admin/settings", { headers: { Cookie: admin.cookie } })).body.default_daily_quota === 7);

    // 設定変更後に新規発行された鍵は既定クォータ 7、キー上限 1 が効く
    const nsk = schnorr.utils.randomSecretKey();
    const npk = hex(schnorr.getPublicKey(nsk));
    const nuser = await loginAs(nsk, npk);
    const k1 = await api("/api/keys", { method: "POST", headers: { ...jsonH, Cookie: nuser.cookie }, body: JSON.stringify({ label: "a" }) });
    check("新規ユーザー1本目発行200", k1.status === 200);
    const me1 = await api("/api/me", { headers: { Cookie: nuser.cookie } });
    check("新規キーに既定クォータ7が付く", me1.body.keys.find((k) => k.key_id === k1.body.key_id)?.daily_quota === 7);
    check("/api/me に max_keys/default_quota", me1.body.max_keys === 1 && me1.body.default_quota === 7);
    check("キー上限1で2本目400", (await api("/api/keys", { method: "POST", headers: { ...jsonH, Cookie: nuser.cookie }, body: JSON.stringify({ label: "b" }) })).status === 400);

    check("settings max_keys範囲外400", (await api("/api/admin/settings", { method: "POST", headers: { ...jsonH, Cookie: admin.cookie }, body: JSON.stringify({ max_keys_per_user: 0 }) })).status === 400);
    check("settings quota範囲外400", (await api("/api/admin/settings", { method: "POST", headers: { ...jsonH, Cookie: admin.cookie }, body: JSON.stringify({ default_daily_quota: 999999 }) })).status === 400);

    // 既定へ戻す(後続テストへの影響を避ける)
    await api("/api/admin/settings", { method: "POST", headers: { ...jsonH, Cookie: admin.cookie }, body: JSON.stringify({ max_keys_per_user: 5, default_daily_quota: 30 }) });
  }

  // quota 変更 → drop クォータに反映(1にして2発目429)
  await seed(4);
  check("管理者 quota変更200", (await api(`/api/admin/keys/${userKeyId}/quota`, { method: "POST", headers: { ...jsonH, Cookie: admin.cookie }, body: JSON.stringify({ daily_quota: 1 }) })).status === 200);
  const d1 = await api("/drop", { headers: { Authorization: `Bearer ${userKey}` } });
  const d2 = await api("/drop", { headers: { Authorization: `Bearer ${userKey}` } });
  check("quota=1で2発目429", d1.status === 200 && d2.status === 429);

  // ban → そのユーザーの鍵で /drop が403
  check("管理者 ban 200", (await api(`/api/admin/users/${victim.user_id}/ban`, { method: "POST", headers: { ...jsonH, Cookie: admin.cookie } })).status === 200);
  check("ban後は鍵で /drop 403", (await api("/drop", { headers: { Authorization: `Bearer ${userKey}` } })).status === 403);
  check("ban後は /api/me 403", (await api("/api/me", { headers: { Cookie: user.cookie } })).status === 403);
  // unban で復帰
  check("管理者 unban 200", (await api(`/api/admin/users/${victim.user_id}/unban`, { method: "POST", headers: { ...jsonH, Cookie: admin.cookie } })).status === 200);
  check("unban後は /api/me 200", (await api("/api/me", { headers: { Cookie: user.cookie } })).status === 200);

  // admin が任意の鍵を無効化
  check("管理者 鍵無効化200", (await api(`/api/admin/keys/${userKeyId}/disable`, { method: "POST", headers: { ...jsonH, Cookie: admin.cookie } })).status === 200);
  check("無効化後は /drop 401", (await api("/drop", { headers: { Authorization: `Bearer ${userKey}` } })).status === 401);

  // 不正入力
  check("quota範囲外400", (await api(`/api/admin/keys/${userKeyId}/quota`, { method: "POST", headers: { ...jsonH, Cookie: admin.cookie }, body: JSON.stringify({ daily_quota: -1 }) })).status === 400);
  check("存在しない鍵404", (await api(`/api/admin/keys/999999/disable`, { method: "POST", headers: { ...jsonH, Cookie: admin.cookie } })).status === 404);
} else {
  console.log("(ADMIN_SK 未設定のため管理者テストはスキップ)");
}

// ── 既存経路の不変 ──
check("/__cron_refill 外部404", (await api("/__cron_refill", { method: "POST" })).status === 404);
check("/refill 無トークン401", (await api("/refill", { method: "POST" })).status === 401);
{
  const s = await api("/status");
  check("/status に version/drops_today/pool_remaining", s.status === 200 && "version" in s.body && "drops_today" in s.body && "pool_remaining" in s.body);
}

console.log(results.map((r) => r.line).join("\n"));
const fails = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
