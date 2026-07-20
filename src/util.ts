// 共通ヘルパー。レスポンス整形と秘密値比較。

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // 真空はキャッシュしない
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      // ?key= が Referer 経由で外部へ漏れない(JSON応答なので本来リンクは無いが構造的に遮断)
      "Referrer-Policy": "no-referrer",
    },
  });
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}
