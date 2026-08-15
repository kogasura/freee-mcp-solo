// 口座の動きの突合。
//
// この方法で weBanana.SP の過年度から実際に誤りが見つかっている
// （2023年 記帳漏れ12件 / 2024年 5件 / 2025年 二重計上23件）。
// 規則を変えると、次に同じ誤りを見つけられなくなる。

import test from "node:test";
import assert from "node:assert/strict";
import {
  compareMovements,
  totalOf,
} from "../dist/tools/compare-wallet-movements.js";

const m = (date, amount) => ({ date, amount });

test("同じなら差は出ない", () => {
  const both = [m("2026-01-10", -1000), m("2026-01-11", 500)];
  const r = compareMovements("口座", both, both);
  assert.equal(r.onlyInBook.length, 0);
  assert.equal(r.onlyInFeed.length, 0);
});

// **本命。** 帳簿にだけある＝二重計上の疑い。
test("帳簿にだけある動きを拾う", () => {
  const book = [m("2026-01-10", -1000), m("2026-01-10", -1000)];
  const feed = [m("2026-01-10", -1000)];

  const r = compareMovements("口座", book, feed);

  assert.deepEqual(r.onlyInBook, [{ date: "2026-01-10", amount: -1000, extra: 1 }]);
  assert.equal(r.onlyInFeed.length, 0);
  assert.equal(totalOf(r.onlyInBook), -1000);
});

// **本命。** 明細にだけある＝記帳漏れの疑い。
test("明細にだけある動きを拾う", () => {
  const book = [];
  const feed = [m("2026-02-27", -31007)];

  const r = compareMovements("口座", book, feed);

  assert.equal(r.onlyInBook.length, 0);
  assert.deepEqual(r.onlyInFeed, [{ date: "2026-02-27", amount: -31007, extra: 1 }]);
});

// **本命。** 同じ日に同額が複数あっても取り違えない。
//
// 2025年3月には 300,000円 の振込が3件あった。1件ずつ消し込む方式だと
// どれがどれか分からなくなり、実際に誤った一覧を出した。件数で比べる。
test("同じ日に同額が複数あっても件数で正しく比べる", () => {
  const book = [
    m("2025-03-18", -300000),
    m("2025-03-20", -300000),
    m("2025-03-24", -300000),
    m("2025-03-24", -300000), // これが余分
  ];
  const feed = [
    m("2025-03-18", -300000),
    m("2025-03-20", -300000),
    m("2025-03-24", -300000),
  ];

  const r = compareMovements("口座", book, feed);

  assert.deepEqual(r.onlyInBook, [
    { date: "2025-03-24", amount: -300000, extra: 1 },
  ]);
  assert.equal(r.onlyInFeed.length, 0, "他の日を巻き込まないこと");
});

// **本命。** 金額の大きい順に並べる。
//
// 先頭しか読まれないことがあるので、並び順が「何を見せるか」になる。
test("金額の大きい順に並べる", () => {
  const book = [
    m("2026-01-10", -145),
    m("2026-01-10", -145),
    m("2026-03-24", -300000),
    m("2026-03-24", -300000),
    m("2026-02-01", -5000),
    m("2026-02-01", -5000),
  ];
  const feed = [m("2026-01-10", -145), m("2026-03-24", -300000), m("2026-02-01", -5000)];

  const r = compareMovements("口座", book, feed);

  assert.equal(r.onlyInBook[0].amount, -300000, "大きい額が先頭");
  assert.equal(r.onlyInBook[1].amount, -5000);
  assert.equal(r.onlyInBook[2].amount, -145);
});

// 余分な件数で重み付けする。
test("同じ金額なら余分な件数が多い方が先", () => {
  const book = [
    m("2026-01-10", -1000),
    m("2026-01-10", -1000),
    m("2026-01-10", -1000), // 余分2件
    m("2026-02-10", -1500),
    m("2026-02-10", -1500), // 余分1件
  ];
  const feed = [m("2026-01-10", -1000), m("2026-02-10", -1500)];

  const r = compareMovements("口座", book, feed);

  assert.equal(r.onlyInBook[0].date, "2026-01-10", "余分2件×1,000 が先");
  assert.equal(r.onlyInBook[0].extra, 2);
});

// 入金と出金は別のものとして扱う（符号を潰さない）。
test("同額の入金と出金を同じものにしない", () => {
  const book = [m("2026-03-12", -330000)];
  const feed = [m("2026-03-12", 330000)];

  const r = compareMovements("口座", book, feed);

  assert.equal(r.onlyInBook.length, 1, "出金は帳簿にだけある");
  assert.equal(r.onlyInFeed.length, 1, "入金は明細にだけある");
});

test("合計は余分な件数で重み付けする", () => {
  assert.equal(
    totalOf([
      { amount: -1000, extra: 2 },
      { amount: -500, extra: 1 },
    ]),
    -2500
  );
  assert.equal(totalOf([]), 0);
});
