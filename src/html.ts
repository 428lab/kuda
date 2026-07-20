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
  const { pubkey, is_admin, keys } = me.body;

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
    html += "<table><tr><th>キー</th><th>ラベル</th><th>本日</th><th>上限/日</th><th>状態</th><th></th></tr>";
    for (const k of keys) {
      html +=
        "<tr><td class=\\"mono\\">" + esc(k.key_prefix) + "…</td>" +
        "<td>" + esc(k.label) + "</td>" +
        "<td>" + k.used_today + "</td>" +
        "<td>" + k.daily_quota + "</td>" +
        "<td>" + (k.disabled_at ? "無効" : "有効") + "</td>" +
        "<td>" + (k.disabled_at ? "" :
          '<button class="disable" data-id="' + k.key_id + '">無効化</button>') + "</td></tr>";
    }
    html += "</table>";
  }

  html +=
    '<div class="row"><input type="text" id="label" placeholder="ラベル(例: my-app)" maxlength="64">' +
    '<button id="create">キーを発行</button></div>' +
    '<p class="muted">有効キーは5本まで。クォータは既定30滴/日(変更は管理者へ)。</p>';

  app.innerHTML = html;

  document.getElementById("logout").addEventListener("click", async () => {
    await api("/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" } });
    renderLogin();
  });
  document.getElementById("create").addEventListener("click", async () => {
    const label = document.getElementById("label").value;
    const res = await api("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
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
}

renderDashboard();
`;
