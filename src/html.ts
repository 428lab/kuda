// ダッシュボードの静的アセット(Worker直配信)。
// フレームワークなし・外部CDNなし。JSは /app.js として別パス配信し、
// HTML側は CSP: script-src 'self' で成立させる。
// ユーザー由来文字列(label等)の描画は app.js 内の esc() で必ずエスケープする。

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>乱数の管 — kuda</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }
  h1 { font-size: 1.4rem; }
  code, .mono { font-family: ui-monospace, monospace; }
  button { padding: .4rem .9rem; cursor: pointer; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { border: 1px solid #8884; padding: .35rem .5rem; text-align: left; font-size: .9rem; }
  .muted { opacity: .65; font-size: .85rem; }
  .newkey { background: #7c31; border: 1px solid #7c36; padding: .8rem; margin: 1rem 0; word-break: break-all; }
  .error { color: #c33; }
  .badge { display: inline-block; font-size: .72rem; padding: .05rem .4rem; border-radius: .6rem;
    background: #d9701a22; border: 1px solid #d9701a66; white-space: nowrap; }
  .row { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin: .8rem 0; }
  input[type=text] { padding: .35rem .5rem; min-width: 14rem; }
  #app { min-height: 8rem; }
</style>
</head>
<body>
<h1>乱数の管 <span class="muted">kuda — 物理ゆらぎのエントロピー配管</span></h1>
<div id="app">読み込み中…</div>
<p class="muted">
  乱数は <code>GET /drop</code> に <code>Authorization: Bearer kuda_…</code> を付けて取得。
  1リクエスト=1バイト(0–255)がプールから不可逆に払い出される。キー単位の日次クォータ制。
  詳細は <a href="https://github.com/428lab/kuda">リポジトリ</a> を参照。
</p>
<script src="/app.js"></script>
</body>
</html>
`;

export const DASHBOARD_JS = `"use strict";
const app = document.getElementById("app");

// ユーザー由来文字列は必ずこれを通す(XSS対策)
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function renderLogin(message) {
  app.innerHTML =
    '<p>APIキーの発行・管理には Nostr でログインします(NIP-07 対応拡張が必要:' +
    ' <a href="https://github.com/nostr-protocol/nips/blob/master/07.md">nos2x, Alby など</a>)。</p>' +
    (message ? '<p class="error">' + esc(message) + '</p>' : "") +
    '<button id="login">NIP-07 でログイン</button>';
  document.getElementById("login").addEventListener("click", login);
}

async function login() {
  if (!window.nostr || !window.nostr.signEvent) {
    renderLogin("NIP-07 拡張が見つかりません。nos2x や Alby をインストールしてください");
    return;
  }
  try {
    const ch = await api("/auth/challenge");
    const event = await window.nostr.signEvent({
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["challenge", ch.body.challenge]],
      content: "",
    });
    const res = await api("/auth/nostr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    if (res.status !== 200) {
      renderLogin("ログイン失敗: " + (res.body.error || res.status));
      return;
    }
    await renderDashboard();
  } catch (e) {
    renderLogin("ログイン中断: " + e.message);
  }
}

async function renderDashboard(newKey) {
  const me = await api("/api/me");
  if (me.status !== 200) { renderLogin(me.body.error); return; }
  const { pubkey, is_admin, keys, max_keys, default_quota } = me.body;

  let html =
    '<div class="row"><span class="mono muted">' + esc(pubkey.slice(0, 16)) + "…</span>" +
    (is_admin ? " <b>[admin]</b>" : "") +
    ' <button id="logout">ログアウト</button></div>';

  if (newKey) {
    html +=
      '<div class="newkey"><b>新しいAPIキー(この画面でしか表示されません):</b><br>' +
      '<code>' + esc(newKey) + '</code><br>' +
      '<button id="copykey">コピー</button></div>';
  }

  html += "<h2>APIキー</h2>";
  if (keys.length === 0) {
    html += '<p class="muted">まだキーがありません。</p>';
  } else {
    html += "<table><tr><th>キー</th><th>種別</th><th>ラベル</th><th>本日</th><th>上限/日</th><th>状態</th><th></th></tr>";
    for (const k of keys) {
      const isQ = String(k.key_prefix).startsWith("kudaq_");
      html +=
        "<tr><td class=\\"mono\\">" + esc(k.key_prefix) + "…</td>" +
        "<td>" + (isQ ? '<span class="badge">半公開(URL可)</span>' : "通常") + "</td>" +
        "<td>" + esc(k.label) + "</td>" +
        "<td>" + k.used_today + "</td>" +
        "<td>" + k.daily_quota + "</td>" +
        "<td>" + (k.disabled_at ? "無効" : "有効") + "</td>" +
        "<td>" + (k.disabled_at ? "" :
          '<button class="disable" data-id="' + esc(k.key_id) + '">無効化</button>') + "</td></tr>";
    }
    html += "</table>";
  }

  html +=
    '<div class="row"><input type="text" id="label" placeholder="ラベル(例: my-app)" maxlength="64">' +
    '<button id="create">キーを発行</button></div>' +
    '<div class="row"><label><input type="checkbox" id="query-key"> ' +
      '半公開キー(URL利用可・低クォータ)として発行</label></div>' +
    '<p class="muted">有効キーは' + esc(max_keys) + '本まで。クォータは既定' +
      esc(default_quota) + '滴/日(変更は管理者へ)。<br>' +
      '通常キーは <code>Authorization: Bearer kuda_…</code> のみ(推奨)。半公開キー(<code>kudaq_…</code>)は ' +
      '<code>?key=</code> でも引けるが、URL に残ると漏れるので低リスク用途のみに。</p>';

  // 分布と一様性検定
  html += "<h2>分布と一様性検定</h2>";
  html += '<div class="row"><label>対象: <select id="statscope"><option value="all">全体</option>';
  for (const k of keys) {
    html += '<option value="' + esc(k.key_id) + '">' + esc(k.key_prefix) + "… " + esc(k.label) + "</option>";
  }
  html += "</select></label>";
  html += ' <label><input type="checkbox" id="agg32"> 32ビンに集約</label></div>';
  html += '<div id="stats" class="muted">読み込み中…</div>';

  if (is_admin) {
    html += "<h2>管理者</h2>";
    html += '<h3>発行ポリシー</h3>' +
      '<div class="row"><label>1人あたり有効キー上限 ' +
      '<input type="number" id="set-maxkeys" min="1" max="1000" style="width:6em"></label></div>' +
      '<div class="row"><label>新規キーの既定クォータ(滴/日) ' +
      '<input type="number" id="set-quota" min="0" max="100000" style="width:8em"></label></div>' +
      '<div class="row"><label>匿名共有の日次上限(滴/日) ' +
      '<input type="number" id="set-anon" min="0" max="1000000" style="width:9em"></label></div>' +
      '<div class="row"><button id="savesettings">保存</button> ' +
      '<span id="settingsmsg" class="muted"></span></div>' +
      '<p class="muted">既定クォータの変更は<b>以後の新規発行</b>に効く(既存キーは各行の「上限変更」で個別に)。' +
      '匿名共有の日次上限は、キー無しアクセス全体の合計/日(移行期間中のみ)。</p>';
    html += '<h3>ユーザー/キー</h3><div class="row"><button id="loadadmin">一覧を読み込む</button></div>';
    html += '<div id="admin"></div>';
  }

  app.innerHTML = html;

  document.getElementById("logout").addEventListener("click", async () => {
    await api("/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" } });
    renderLogin();
  });
  document.getElementById("create").addEventListener("click", async () => {
    const label = document.getElementById("label").value;
    const queryEl = document.getElementById("query-key");
    const query_allowed = !!(queryEl && queryEl.checked);
    const res = await api("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, query_allowed }),
    });
    if (res.status !== 200) { alert("発行失敗: " + (res.body.error || res.status)); return; }
    await renderDashboard(res.body.key);
  });
  const copyBtn = document.getElementById("copykey");
  if (copyBtn && newKey) {
    copyBtn.addEventListener("click", () => navigator.clipboard.writeText(newKey));
  }
  for (const btn of document.querySelectorAll("button.disable")) {
    btn.addEventListener("click", async () => {
      if (!confirm("このキーを無効化しますか?(元に戻せません)")) return;
      const res = await api("/api/keys/" + btn.dataset.id + "/disable", {
        method: "POST", headers: { "Content-Type": "application/json" },
      });
      if (res.status !== 200) { alert("無効化失敗: " + (res.body.error || res.status)); return; }
      await renderDashboard();
    });
  }

  const scopeEl = document.getElementById("statscope");
  const aggEl = document.getElementById("agg32");
  scopeEl.addEventListener("change", loadStats);
  aggEl.addEventListener("change", loadStats);
  loadStats();

  const loadAdminBtn = document.getElementById("loadadmin");
  if (loadAdminBtn) loadAdminBtn.addEventListener("click", loadAdmin);

  const saveSettingsBtn = document.getElementById("savesettings");
  if (saveSettingsBtn) {
    loadSettings();
    saveSettingsBtn.addEventListener("click", saveSettings);
  }
}

async function loadSettings() {
  const res = await api("/api/admin/settings");
  if (res.status !== 200) return;
  document.getElementById("set-maxkeys").value = res.body.max_keys_per_user;
  document.getElementById("set-quota").value = res.body.default_daily_quota;
  document.getElementById("set-anon").value = res.body.anon_daily_limit;
}

async function saveSettings() {
  const msg = document.getElementById("settingsmsg");
  const maxKeys = Number(document.getElementById("set-maxkeys").value);
  const quota = Number(document.getElementById("set-quota").value);
  const anon = Number(document.getElementById("set-anon").value);
  if (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > 1000) {
    msg.textContent = "有効キー上限は1..1000の整数で"; return;
  }
  if (!Number.isInteger(quota) || quota < 0 || quota > 100000) {
    msg.textContent = "既定クォータは0..100000の整数で"; return;
  }
  if (!Number.isInteger(anon) || anon < 0 || anon > 1000000) {
    msg.textContent = "匿名共有の日次上限は0..1000000の整数で"; return;
  }
  const res = await api("/api/admin/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ max_keys_per_user: maxKeys, default_daily_quota: quota, anon_daily_limit: anon }),
  });
  msg.textContent = res.status === 200 ? "保存しました" : "失敗: " + (res.body.error || res.status);
}

async function adminPost(path, confirmMsg, body) {
  if (confirmMsg && !confirm(confirmMsg)) return false;
  const res = await api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (res.status !== 200) { alert("失敗: " + (res.body.error || res.status)); return false; }
  return true;
}

function keyRowAdmin(k) {
  return "<tr><td class=\\"mono\\">" + esc(k.key_prefix) + "…</td>" +
    "<td>" + esc(k.label) + "</td>" +
    "<td>" + k.used_today + "/" + k.daily_quota + "</td>" +
    "<td>" + (k.disabled_at ? "無効" : "有効") + "</td>" +
    '<td><button class="a-quota" data-id="' + esc(k.key_id) + '">上限変更</button> ' +
    (k.disabled_at ? "" : '<button class="a-disable" data-id="' + esc(k.key_id) + '">無効化</button>') +
    "</td></tr>";
}

async function loadAdmin() {
  const el = document.getElementById("admin");
  el.textContent = "読み込み中…";
  const res = await api("/api/admin/users");
  if (res.status !== 200) { el.textContent = "取得失敗: " + (res.body.error || res.status); return; }
  const { users, system_keys } = res.body;

  let html = "";
  for (const u of users) {
    const banned = !!u.banned_at;
    html += '<div class="admin-user">' +
      '<div class="row"><span class="mono">' + esc(u.pubkey.slice(0, 16)) + "…</span>" +
      (banned ? ' <b class="error">BANNED</b>' : "") +
      ' <button class="a-ban" data-id="' + esc(u.user_id) + '" data-ban="' + (banned ? "0" : "1") + '">' +
      (banned ? "ban解除" : "ban") + "</button></div>";
    if (u.keys.length) {
      html += "<table><tr><th>キー</th><th>ラベル</th><th>本日/上限</th><th>状態</th><th></th></tr>";
      for (const k of u.keys) html += keyRowAdmin(k);
      html += "</table>";
    } else {
      html += '<p class="muted">キーなし</p>';
    }
    html += "</div>";
  }
  if (system_keys.length) {
    html += "<h3>システム鍵(user_id なし・/admin/keys 発行)</h3>";
    html += "<table><tr><th>キー</th><th>ラベル</th><th>本日/上限</th><th>状態</th><th></th></tr>";
    for (const k of system_keys) html += keyRowAdmin(k);
    html += "</table>";
  }
  el.innerHTML = html || '<p class="muted">ユーザーがいません。</p>';

  for (const btn of el.querySelectorAll("button.a-ban")) {
    btn.addEventListener("click", async () => {
      const ban = btn.dataset.ban === "1";
      const path = "/api/admin/users/" + btn.dataset.id + (ban ? "/ban" : "/unban");
      if (await adminPost(path, ban ? "このユーザーをbanしますか?" : null)) loadAdmin();
    });
  }
  for (const btn of el.querySelectorAll("button.a-disable")) {
    btn.addEventListener("click", async () => {
      if (await adminPost("/api/admin/keys/" + btn.dataset.id + "/disable", "この鍵を無効化しますか?")) loadAdmin();
    });
  }
  for (const btn of el.querySelectorAll("button.a-quota")) {
    btn.addEventListener("click", async () => {
      const v = prompt("新しい日次クォータ(0..100000)");
      if (v === null) return;
      const q = Number(v);
      if (!Number.isInteger(q) || q < 0 || q > 100000) { alert("0..100000の整数で"); return; }
      if (await adminPost("/api/admin/keys/" + btn.dataset.id + "/quota", null, { daily_quota: q })) loadAdmin();
    });
  }
}

// SVG棒グラフを文字列で組み立てる(外部リソース不要・CSPに抵触しない)。
function svgHistogram(hist, n) {
  const W = 640, H = 170, PAD = 12, bins = hist.length;
  const bw = W / bins;
  const max = Math.max(1, ...hist);
  const exp = n / bins;
  const y = (v) => H - PAD - (v / max) * (H - 2 * PAD);
  let bars = "";
  for (let i = 0; i < bins; i++) {
    const yy = y(hist[i]);
    bars += '<rect x="' + (i * bw).toFixed(2) + '" y="' + yy.toFixed(2) +
      '" width="' + Math.max(0.6, bw - 0.3).toFixed(2) + '" height="' + (H - PAD - yy).toFixed(2) +
      '" fill="#4a90d9"></rect>';
  }
  const ey = y(exp).toFixed(2);
  const expLine = '<line x1="0" y1="' + ey + '" x2="' + W + '" y2="' + ey +
    '" stroke="#c33" stroke-width="1" stroke-dasharray="4 3"></line>';
  return '<svg viewBox="0 0 ' + W + " " + H + '" width="100%" height="170" ' +
    'style="border:1px solid #8884;background:#8881" role="img" ' +
    'aria-label="バイト値の分布ヒストグラム">' + bars + expLine + "</svg>";
}

function aggregate(hist, groups) {
  const size = hist.length / groups;
  const out = new Array(groups).fill(0);
  for (let i = 0; i < hist.length; i++) out[Math.floor(i / size)] += hist[i];
  return out;
}

async function loadStats() {
  const stats = document.getElementById("stats");
  const scope = document.getElementById("statscope").value;
  const agg = document.getElementById("agg32").checked;
  stats.textContent = "読み込み中…";
  const res = await api("/api/stats?key_id=" + encodeURIComponent(scope));
  if (res.status !== 200) { stats.textContent = "取得失敗: " + (res.body.error || res.status); return; }
  const b = res.body;
  if (b.n === 0) { stats.innerHTML = '<p class="muted">まだ払い出しがありません。</p>'; return; }
  const hist = agg ? aggregate(b.histogram, 32) : b.histogram;
  const pStr = b.p_value === null ? "—" : b.p_value.toFixed(4);
  const verdict = b.p_value === null ? "" :
    (b.p_value > 0.05 ? " (一様と矛盾しない)" : " (⚠ 一様から逸脱の疑い)");
  let html = svgHistogram(hist, b.n);
  html += '<p class="muted">赤い破線 = 一様なら期待される水準。棒がそこに揃うほど健全。</p>';
  html += "<table>" +
    "<tr><th>サンプル数 n</th><td>" + b.n + "</td></tr>" +
    "<tr><th>χ²(df=" + b.df + ")</th><td>" + b.chi2 + "</td></tr>" +
    "<tr><th>p値</th><td>" + esc(pStr) + esc(verdict) + "</td></tr>" +
    "</table>";
  html += '<p class="muted">' + esc(b.note) + "</p>";
  if (!b.sufficient) html += '<p class="error">サンプル不足のため参考値です。</p>';
  stats.innerHTML = html;
}

renderDashboard();
`;
