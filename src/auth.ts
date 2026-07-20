// APIキー・クォータの純粋ヘルパー。SQLアクセスは pool.ts(DO)側で行う。
//
// 規律: APIキーの生成にエントロピープールの粒は絶対に使わない。
// drops 表は値を含む監査ログなので、プール由来の鍵は素材がログに残ってしまう。
// 鍵は運用秘密であって「一滴」ではない — Workers の CSPRNG を使う。

export const API_KEY_PREFIX = "kuda_";

// 32バイトCSPRNG → kuda_ + 64hex。平文は発行時に一度だけ返し、保存はSHA-256のみ。
export function generateApiKey(): { plaintext: string; prefix: string } {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  return {
    plaintext: API_KEY_PREFIX + hex,
    // 表示・識別用の先頭のみ(秘密ではない)
    prefix: API_KEY_PREFIX + hex.slice(0, 8),
  };
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// クォータの「日」はUTC日付で切る(実装最小・リセットジョブ不要)。
// drawn_at はISO文字列なので辞書順比較がそのまま時刻比較になる。
export function utcDayStartIso(now = new Date()): string {
  return now.toISOString().slice(0, 10) + "T00:00:00.000Z";
}

export function nextUtcMidnightIso(now = new Date()): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  ).toISOString();
}

// client_id は秘密ではない識別子。[a-z0-9_-] 32文字に正規化。
export function sanitizeClientId(raw: string | null): string {
  return (raw ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
}

// ── セッションCookie(HMAC-SHA256署名) ─────────────────────────────
// 形式: base64url(JSON{pubkey,exp}) + "." + base64url(HMAC)
// SESSION_SECRET は Worker Secret。Cookie は HttpOnly+SameSite=Lax(+本番は Secure)。

export const SESSION_COOKIE = "kuda_session";
export const SESSION_TTL_SEC = 7 * 24 * 60 * 60; // 7日

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}

export async function createSessionCookieValue(
  secret: string, pubkey: string, nowSec = Math.floor(Date.now() / 1000)
): Promise<string> {
  const payload = b64urlEncode(
    new TextEncoder().encode(JSON.stringify({ pubkey, exp: nowSec + SESSION_TTL_SEC }))
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(payload))
  );
  return `${payload}.${b64urlEncode(sig)}`;
}

// 検証OKなら pubkey を返す。失敗(改ざん・期限切れ・形式不正)は null。
export async function verifySessionCookieValue(
  secret: string, value: string, nowSec = Math.floor(Date.now() / 1000)
): Promise<string | null> {
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const sigBytes = b64urlDecode(value.slice(dot + 1));
  if (!sigBytes) return null;
  const ok = await crypto.subtle.verify(
    "HMAC", await hmacKey(secret), sigBytes as BufferSource,
    new TextEncoder().encode(payload)
  );
  if (!ok) return null;
  const payloadBytes = b64urlDecode(payload);
  if (!payloadBytes) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as { pubkey?: string; exp?: number };
    if (typeof parsed.pubkey !== "string" || !/^[0-9a-f]{64}$/.test(parsed.pubkey)) return null;
    if (typeof parsed.exp !== "number" || parsed.exp <= nowSec) return null;
    return parsed.pubkey;
  } catch {
    return null;
  }
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

// Set-Cookie 値。ローカル開発(http://localhost)では Secure を外す。
export function sessionSetCookie(value: string, hostname: string, maxAge = SESSION_TTL_SEC): string {
  const secure = hostname === "localhost" || hostname === "127.0.0.1" ? "" : "; Secure";
  return `${SESSION_COOKIE}=${value}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

// CSRF対策: 状態変更APIは (1) Content-Type: application/json 必須
// (2) Origin ヘッダがあれば自オリジンと一致必須(ブラウザのクロスオリジンPOSTを遮断)。
export function csrfViolation(req: Request, url: URL): string | null {
  const ct = req.headers.get("Content-Type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) return "Content-Type must be application/json";
  const origin = req.headers.get("Origin");
  if (origin && origin !== url.origin) return "cross-origin request rejected";
  return null;
}
