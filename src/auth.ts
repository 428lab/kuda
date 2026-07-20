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
