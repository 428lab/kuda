// Nostr NIP-07 ログインの検証(サーバー側)。
//
// クライアント(ブラウザ拡張)は NIP-42 型の認証イベント kind 22242 を署名して送る:
//   { pubkey, created_at, kind: 22242, tags: [["challenge", "<server発行>"], ...],
//     content: "", id, sig }
// サーバーは以下を全て検証する(順序固定・最初の違反で拒否):
//   1. 形式(hex長・型)
//   2. NIP-01 直列化 [0,pubkey,created_at,kind,tags,content] の sha256 == id
//   3. schnorr 署名(secp256k1, x-only pubkey)
//   4. challenge がサーバー発行済みかは呼び出し側(pool.ts)がDBで確認する
//   5. created_at が現在時刻 ±10分

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const AUTH_EVENT_KIND = 22242;
export const CREATED_AT_SKEW_SEC = 600; // ±10分

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// 形式検証。通れば NostrEvent として扱ってよい。
export function isValidEventShape(e: unknown): e is NostrEvent {
  if (typeof e !== "object" || e === null) return false;
  const ev = e as Record<string, unknown>;
  return (
    typeof ev.id === "string" && HEX64.test(ev.id) &&
    typeof ev.pubkey === "string" && HEX64.test(ev.pubkey) &&
    typeof ev.created_at === "number" && Number.isInteger(ev.created_at) &&
    typeof ev.kind === "number" && Number.isInteger(ev.kind) &&
    Array.isArray(ev.tags) &&
    ev.tags.every((t) => Array.isArray(t) && t.every((s) => typeof s === "string")) &&
    typeof ev.content === "string" &&
    typeof ev.sig === "string" && HEX128.test(ev.sig)
  );
}

// NIP-01: id = sha256(JSON.stringify([0,pubkey,created_at,kind,tags,content]))
// JSON.stringify の最小エスケープは NIP-01 の規定と一致する。
export function computeEventId(e: NostrEvent): string {
  const serialized = JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
  return bytesToHex(sha256(new TextEncoder().encode(serialized)));
}

// challenge タグの値を取り出す(最初の ["challenge", value])
export function getChallengeTag(e: NostrEvent): string | null {
  const tag = e.tags.find((t) => t[0] === "challenge" && typeof t[1] === "string");
  return tag ? tag[1] : null;
}

export type AuthEventError =
  | "invalid event shape"
  | "wrong kind"
  | "id mismatch"
  | "bad signature"
  | "created_at out of range";

// ログインイベントの自己完結部分(形式・kind・id・署名・時刻)を検証。
// challenge のDB照合は含まない(呼び出し側の責務)。
export function verifyAuthEvent(e: unknown, nowSec = Math.floor(Date.now() / 1000)): AuthEventError | null {
  if (!isValidEventShape(e)) return "invalid event shape";
  if (e.kind !== AUTH_EVENT_KIND) return "wrong kind";
  if (computeEventId(e) !== e.id) return "id mismatch";
  let ok = false;
  try {
    ok = schnorr.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey));
  } catch {
    ok = false;
  }
  if (!ok) return "bad signature";
  if (Math.abs(nowSec - e.created_at) > CREATED_AT_SKEW_SEC) return "created_at out of range";
  return null;
}
