import { describe, expect, it } from "vitest";
import {
  createSessionCookieValue,
  csrfViolation,
  generateApiKey,
  nextUtcMidnightIso,
  parseCookies,
  sanitizeClientId,
  sessionSetCookie,
  sha256Hex,
  utcDayStartIso,
  verifySessionCookieValue,
  API_KEY_PREFIX,
} from "../src/auth";

const SECRET = "test-secret-abcdef";

describe("auth: APIキー生成", () => {
  it("kuda_ + 64hex、prefixは先頭のみ", () => {
    const { plaintext, prefix } = generateApiKey();
    expect(plaintext).toMatch(/^kuda_[0-9a-f]{64}$/);
    expect(prefix).toBe(API_KEY_PREFIX + plaintext.slice(5, 13));
    expect(plaintext.length).toBe(69);
  });
  it("毎回異なる(CSPRNG)", () => {
    const a = generateApiKey().plaintext;
    const b = generateApiKey().plaintext;
    expect(a).not.toBe(b);
  });
  it("sha256Hex は既知ベクタ", async () => {
    // sha256("") = e3b0c442...
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });
});

describe("auth: セッションCookie(HMAC)", () => {
  const now = 1_700_000_000;
  const pubkey = "a".repeat(64);

  it("create→verify のラウンドトリップで pubkey を復元", async () => {
    const v = await createSessionCookieValue(SECRET, pubkey, now);
    expect(await verifySessionCookieValue(SECRET, v, now)).toBe(pubkey);
  });
  it("署名改ざん → null", async () => {
    const v = await createSessionCookieValue(SECRET, pubkey, now);
    const tampered = v.slice(0, -3) + (v.endsWith("aaa") ? "bbb" : "aaa");
    expect(await verifySessionCookieValue(SECRET, tampered, now)).toBeNull();
  });
  it("別 secret では検証失敗 → null", async () => {
    const v = await createSessionCookieValue(SECRET, pubkey, now);
    expect(await verifySessionCookieValue("other-secret", v, now)).toBeNull();
  });
  it("期限切れ(exp <= now) → null", async () => {
    const v = await createSessionCookieValue(SECRET, pubkey, now);
    // 7日+1秒後
    expect(await verifySessionCookieValue(SECRET, v, now + 7 * 24 * 3600 + 1)).toBeNull();
  });
  it("壊れた形式 → null(例外を投げない)", async () => {
    expect(await verifySessionCookieValue(SECRET, "garbage", now)).toBeNull();
    expect(await verifySessionCookieValue(SECRET, "a.b.c", now)).toBeNull();
    expect(await verifySessionCookieValue(SECRET, "", now)).toBeNull();
  });
});

describe("auth: Cookie属性", () => {
  it("本番は Secure 付き", () => {
    const sc = sessionSetCookie("v", "kuda.example.com");
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/SameSite=Lax/);
    expect(sc).toMatch(/Secure/);
  });
  it("localhost は Secure なし", () => {
    expect(sessionSetCookie("v", "localhost")).not.toMatch(/Secure/);
    expect(sessionSetCookie("v", "127.0.0.1")).not.toMatch(/Secure/);
  });
  it("Max-Age=0 で削除", () => {
    expect(sessionSetCookie("", "localhost", 0)).toMatch(/Max-Age=0/);
  });
});

describe("auth: parseCookies", () => {
  it("複数Cookieを分解", () => {
    expect(parseCookies("a=1; kuda_session=xyz; b=2")).toMatchObject({
      a: "1", kuda_session: "xyz", b: "2",
    });
  });
  it("null/空は空オブジェクト", () => {
    expect(parseCookies(null)).toEqual({});
  });
});

describe("auth: sanitizeClientId", () => {
  it("英数_- 以外を除去し32文字に切る", () => {
    expect(sanitizeClientId("My-App_01!")).toBe("my-app_01");
    expect(sanitizeClientId("あいう<script>")).toBe("script");
    expect(sanitizeClientId("x".repeat(40)).length).toBe(32);
    expect(sanitizeClientId(null)).toBe("");
  });
});

describe("auth: UTC日境界", () => {
  it("utcDayStartIso はその日の00:00Z", () => {
    expect(utcDayStartIso(new Date("2026-07-20T15:30:00Z"))).toBe("2026-07-20T00:00:00.000Z");
  });
  it("nextUtcMidnightIso は翌日00:00Z(月跨ぎ)", () => {
    expect(nextUtcMidnightIso(new Date("2026-07-31T23:59:00Z"))).toBe("2026-08-01T00:00:00.000Z");
    expect(nextUtcMidnightIso(new Date("2026-12-31T10:00:00Z"))).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("auth: csrfViolation", () => {
  const url = new URL("https://kuda.example.com/api/keys");
  it("JSON + 同一Origin は通過(null)", () => {
    const req = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://kuda.example.com" },
    });
    expect(csrfViolation(req, url)).toBeNull();
  });
  it("Content-Type 非JSON → 拒否", () => {
    const req = new Request(url, { method: "POST", headers: { "Content-Type": "text/plain" } });
    expect(csrfViolation(req, url)).toMatch(/Content-Type/);
  });
  it("クロスオリジン → 拒否", () => {
    const req = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    });
    expect(csrfViolation(req, url)).toMatch(/cross-origin/);
  });
  it("Origin無し(非ブラウザ)は JSON なら通過", () => {
    const req = new Request(url, { method: "POST", headers: { "Content-Type": "application/json" } });
    expect(csrfViolation(req, url)).toBeNull();
  });
});
