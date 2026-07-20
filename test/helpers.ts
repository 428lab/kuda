// テスト用ヘルパー: 使い捨て鍵ペアで NIP-07 認証イベントを署名する。
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export const unhex = (s: string): Uint8Array =>
  Uint8Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.slice(i * 2, i * 2 + 2), 16));

export interface TestKeypair {
  sk: Uint8Array;
  pk: string; // x-only 64hex
}

export function newKeypair(): TestKeypair {
  const sk = schnorr.utils.randomSecretKey();
  return { sk, pk: hex(schnorr.getPublicKey(sk)) };
}

// NIP-01 直列化 → id → schnorr 署名で完全なイベントを作る。
export function signEvent(
  kp: TestKeypair,
  opts: { kind?: number; created_at?: number; tags?: string[][]; content?: string } = {}
) {
  const kind = opts.kind ?? 22242;
  const created_at = opts.created_at ?? Math.floor(Date.now() / 1000);
  const tags = opts.tags ?? [];
  const content = opts.content ?? "";
  const serialized = JSON.stringify([0, kp.pk, created_at, kind, tags, content]);
  const id = hex(sha256(new TextEncoder().encode(serialized)));
  const sig = hex(schnorr.sign(unhex(id), kp.sk));
  return { id, pubkey: kp.pk, created_at, kind, tags, content, sig };
}
