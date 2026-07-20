import { describe, expect, it } from "vitest";
import {
  computeEventId,
  getChallengeTag,
  isValidEventShape,
  verifyAuthEvent,
  AUTH_EVENT_KIND,
} from "../src/nostr";
import { newKeypair, signEvent } from "./helpers";

describe("nostr: computeEventId (NIP-01)", () => {
  it("固定ベクタの id を再現する", async () => {
    // NIP-01 直列化 [0,pubkey,created_at,kind,tags,content] の sha256(hex)。
    // helpers.signEvent(@noble)とは独立に、Web Crypto で期待値を計算して
    // src の computeEventId を検証する固定ベクタ。
    const ev = {
      id: "",
      pubkey: "0000000000000000000000000000000000000000000000000000000000000001",
      created_at: 1700000000,
      kind: 1,
      tags: [["t", "kuda"]] as string[][],
      content: "hello",
      sig: "0".repeat(128),
    };
    const serialized = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
    const expected = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(computeEventId(ev)).toBe(expected);
    // content が1文字変われば id も変わる(id感度)
    expect(computeEventId({ ...ev, content: "hell0" })).not.toBe(expected);
  });
});

describe("nostr: verifyAuthEvent", () => {
  const kp = newKeypair();
  const now = Math.floor(Date.now() / 1000);

  it("正しく署名された kind 22242 は null(合格)", () => {
    const ev = signEvent(kp, { kind: AUTH_EVENT_KIND, created_at: now, tags: [["challenge", "abc"]] });
    expect(verifyAuthEvent(ev, now)).toBeNull();
  });

  it("形式不正 → 'invalid event shape'", () => {
    expect(verifyAuthEvent({ nope: true }, now)).toBe("invalid event shape");
    expect(verifyAuthEvent(null, now)).toBe("invalid event shape");
    // pubkey が非hex
    const ev = signEvent(kp, { kind: AUTH_EVENT_KIND, created_at: now });
    expect(verifyAuthEvent({ ...ev, pubkey: "ZZZ" }, now)).toBe("invalid event shape");
  });

  it("kind 違い → 'wrong kind'", () => {
    const ev = signEvent(kp, { kind: 1, created_at: now });
    expect(verifyAuthEvent(ev, now)).toBe("wrong kind");
  });

  it("id 改ざん(content不一致) → 'id mismatch'", () => {
    const ev = signEvent(kp, { kind: AUTH_EVENT_KIND, created_at: now });
    expect(verifyAuthEvent({ ...ev, content: "tampered" }, now)).toBe("id mismatch");
  });

  it("署名改ざん → 'bad signature'", () => {
    const ev = signEvent(kp, { kind: AUTH_EVENT_KIND, created_at: now });
    const flipped = ev.sig.slice(0, -2) + (ev.sig.endsWith("00") ? "01" : "00");
    expect(verifyAuthEvent({ ...ev, sig: flipped }, now)).toBe("bad signature");
  });

  it("別鍵の署名(なりすまし) → 'bad signature'", () => {
    const other = newKeypair();
    const ev = signEvent(kp, { kind: AUTH_EVENT_KIND, created_at: now });
    const forged = signEvent(other, { kind: AUTH_EVENT_KIND, created_at: now });
    // 被害者のpubkeyに攻撃者の署名を貼る → id もずれるが、まず id を合わせても sig で落ちる
    expect(verifyAuthEvent({ ...ev, sig: forged.sig }, now)).toBe("bad signature");
  });

  it("created_at が ±10分超 → 'created_at out of range'", () => {
    const ev = signEvent(kp, { kind: AUTH_EVENT_KIND, created_at: now - 1200 });
    expect(verifyAuthEvent(ev, now)).toBe("created_at out of range");
    const future = signEvent(kp, { kind: AUTH_EVENT_KIND, created_at: now + 1200 });
    expect(verifyAuthEvent(future, now)).toBe("created_at out of range");
  });

  it("境界: ちょうど±600秒は許容", () => {
    const ev = signEvent(kp, { kind: AUTH_EVENT_KIND, created_at: now - 600 });
    expect(verifyAuthEvent(ev, now)).toBeNull();
  });
});

describe("nostr: helpers", () => {
  it("getChallengeTag は最初の challenge タグ値", () => {
    const kp = newKeypair();
    const ev = signEvent(kp, { tags: [["other", "x"], ["challenge", "C1"], ["challenge", "C2"]] });
    expect(getChallengeTag(ev)).toBe("C1");
  });
  it("challenge タグ無しは null", () => {
    const kp = newKeypair();
    const ev = signEvent(kp, { tags: [["x", "y"]] });
    expect(getChallengeTag(ev)).toBeNull();
  });
  it("isValidEventShape は非文字列タグを弾く", () => {
    const kp = newKeypair();
    const ev = signEvent(kp, {});
    expect(isValidEventShape({ ...ev, tags: [[1, 2]] })).toBe(false);
  });
});
