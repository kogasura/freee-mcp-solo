// 「明細が途絶えている口座」の注意書きの検査。
//
// **0件の報告が信用できるかを示すためのもの。** この検査は明細と取引を
// 突き合わせるので、明細自体が来ていなければ何も見つからない。
// 口座同期が止まっていると「記帳漏れ 0件」と出るが、それは
// 「漏れていない」ではなく「調べようがない」である。

import test from "node:test";
import assert from "node:assert/strict";
import { staleFeedNote } from "../dist/tools/unrecorded-transactions.js";

function wallet(id, name) {
  return { id, name, type: "credit_card" };
}

// **本命。** 明細が途絶えている口座を挙げる。
//
// 実際に踏んだ形: 2026-08-16 時点で モバイルSuica の明細が 2026-07-15 で
// 止まっていた（6月98件・7月50件・8月0件）のに、8月の検査は 0件 と報告した。
test("明細が途絶えている口座を挙げる", () => {
  const wallets = [wallet(1, "モバイルSuica")];
  const last = new Map([[1, "2026-07-15"]]);

  const note = staleFeedNote(wallets, last, "2026-08-16");

  assert.ok(note.includes("モバイルSuica"), note);
  assert.ok(note.includes("2026-07-15"), "最終の日を出すこと");
  assert.ok(note.includes("32日前"), "何日前かを出すこと");
  assert.ok(
    note.includes("記帳漏れを見つけられません"),
    "0件が信用できない理由を言うこと"
  );
});

test("最近まで明細が来ていれば何も言わない", () => {
  const wallets = [wallet(1, "ＰａｙＰａｙ銀行")];
  const last = new Map([[1, "2026-08-14"]]);
  assert.equal(staleFeedNote(wallets, last, "2026-08-16"), "");
});

// **本命。** 一度も明細が無い口座は対象外。
//
// 使っていないだけの口座がある（実帳簿ではエポスカードと現金がそう）。
// 挙げると、毎回出る意味の無い注意書きになる。
test("一度も明細が無い口座は挙げない", () => {
  const wallets = [wallet(1, "エポスカード")];
  const last = new Map([[1, null]]);
  assert.equal(staleFeedNote(wallets, last, "2026-08-16"), "");
});

test("境界は指定した日数で切り替わる", () => {
  const wallets = [wallet(1, "カード")];
  // 13日前は出さない、14日前は出す。
  assert.equal(
    staleFeedNote(wallets, new Map([[1, "2026-08-03"]]), "2026-08-16", 14),
    ""
  );
  assert.notEqual(
    staleFeedNote(wallets, new Map([[1, "2026-08-02"]]), "2026-08-16", 14),
    ""
  );
});

test("複数の口座をまとめて挙げる", () => {
  const wallets = [wallet(1, "カードA"), wallet(2, "カードB"), wallet(3, "銀行")];
  const last = new Map([
    [1, "2026-07-12"],
    [2, "2026-07-27"],
    [3, "2026-08-14"],
  ]);

  const note = staleFeedNote(wallets, last, "2026-08-16");

  assert.ok(note.includes("カードA"), note);
  assert.ok(note.includes("カードB"), note);
  assert.ok(!note.includes("銀行"), "最近まで来ている口座は挙げない: " + note);
});
