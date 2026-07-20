import { describe, expect, it } from "vitest";
import { json, timingSafeEqual } from "../src/util";

describe("util: timingSafeEqual", () => {
  it("等しい文字列は true", () => {
    expect(timingSafeEqual("hunter2", "hunter2")).toBe(true);
  });
  it("異なる/長さ違いは false", () => {
    expect(timingSafeEqual("a", "b")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "x")).toBe(false);
  });
  it("マルチバイトも正しく比較", () => {
    expect(timingSafeEqual("あ", "あ")).toBe(true);
    expect(timingSafeEqual("あ", "い")).toBe(false);
  });
});

describe("util: json", () => {
  it("no-store と Content-Type を付ける", async () => {
    const res = json({ ok: true }, 201);
    expect(res.status).toBe(201);
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
    expect(res.headers.get("Cache-Control")).toMatch(/no-store/);
    expect(await res.json()).toEqual({ ok: true });
  });
});
