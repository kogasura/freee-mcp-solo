// トークン更新の検査。
//
// **リフレッシュトークンは1回しか使えない。** 別のプロセスが先に更新したのに
// メモリの古いリフレッシュトークンで更新すると 401 になり、MCP が落ちる
// （2026-09-15 に実際に起きた）。ディスクの方が新しく有効なら、それを使う。

import test from "node:test";
import assert from "node:assert/strict";
import { isUsableNewerToken } from "../dist/auth/token-manager.js";

const now = 1_800_000_000_000;
const tok = (expiresInMin) => ({
  access_token: "a",
  refresh_token: "r",
  token_type: "bearer",
  scope: "",
  expires_at: now + expiresInMin * 60_000,
});

test("ディスクの方が新しく十分に有効なら使う", () => {
  assert.equal(isUsableNewerToken(tok(2), tok(300), now), true);
});

test("ディスクが同じか古ければ使わない（自分で更新する）", () => {
  assert.equal(isUsableNewerToken(tok(2), tok(2), now), false);
  assert.equal(isUsableNewerToken(tok(300), tok(2), now), false);
});

test("ディスクが新しくても期限間近なら使わない", () => {
  assert.equal(isUsableNewerToken(tok(-10), tok(3), now), false);
});

test("メモリに無ければ、有効なディスクのトークンを使う", () => {
  assert.equal(isUsableNewerToken(null, tok(300), now), true);
});
