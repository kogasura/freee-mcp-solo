// 請求書のページ辿りの検査。
//
// **`per_page` を大きくしても freee は1ページ20件しか返さない。**
// 以前は1回引いて打ち切っており、新しい順に20件しか見えていなかった。
// 実帳簿では2025年12月より後の請求書10件が丸ごと隠れており、売掛金を
// 数えようとして「2026年分が1件も無い」ことで気づいた。
//
// **黙って途中で切れる読み取りは、無いのと同じか、それより悪い。**
// 「請求書は20件」と読めてしまう。

import test from "node:test";
import assert from "node:assert/strict";
import { fetchAllInvoices } from "../dist/tools/list-invoices.js";

/** offset ごとにページを返す偽の取得関数。何回呼ばれたかも数える。 */
function pager(total) {
  const calls = [];
  const fetchPage = async (offset) => {
    calls.push(offset);
    return Array.from({ length: Math.max(0, Math.min(20, total - offset)) }, (_, i) => ({
      id: offset + i + 1,
    }));
  };
  return { fetchPage, calls };
}

// **本命。** 20件を超えても全部取れる。
//
// 実帳簿は30件で、以前は20件しか見えていなかった。
test("20件を超える請求書を全部取る", async () => {
  const { fetchPage, calls } = pager(30);

  const got = await fetchAllInvoices(fetchPage, 200);

  assert.equal(got.length, 30);
  assert.deepEqual(calls, [0, 20], "2ページ引くこと");
});

// **本命。** ちょうど割り切れるとき、空ページを1回余分に引く。
//
// 件数で打ち切ると、40件のとき3回目を引くことになる。**それが正しい**
// ——40件で止めると、41件目があるかどうか分からないからである。
test("ちょうど割り切れるときは空ページで最後を確かめる", async () => {
  const { fetchPage, calls } = pager(40);

  const got = await fetchAllInvoices(fetchPage, 200);

  assert.equal(got.length, 40);
  assert.deepEqual(calls, [0, 20, 40], "空ページを引いて終わりを確かめる");
});

// 1ページで終わるなら1回だけ引く。
test("1ページで終わるなら余分に引かない", async () => {
  const { fetchPage, calls } = pager(5);

  const got = await fetchAllInvoices(fetchPage, 200);

  assert.equal(got.length, 5);
  assert.deepEqual(calls, [0]);
});

// **本命。** 上限に達したらそこで止める。
test("上限で打ち切る", async () => {
  const { fetchPage, calls } = pager(100);

  const got = await fetchAllInvoices(fetchPage, 25);

  assert.equal(got.length, 25, "上限ちょうどに切る");
  assert.deepEqual(calls, [0, 20], "上限を超えたら引かない");
});

// 0件でも落ちない。
test("1件も無ければ空を返す", async () => {
  const { fetchPage, calls } = pager(0);

  assert.deepEqual(await fetchAllInvoices(fetchPage, 200), []);
  assert.deepEqual(calls, [0]);
});

// **本命。** 無限に回らない。
//
// 常に満杯のページを返す（終わりが来ない）相手でも止まる。
test("終わりが来なくても止まる", async () => {
  let calls = 0;
  const fetchPage = async () => {
    calls++;
    return Array.from({ length: 20 }, (_, i) => ({ id: i }));
  };

  const got = await fetchAllInvoices(fetchPage, 100_000);

  assert.equal(calls, 100, "ページ数の上限で止まること");
  assert.equal(got.length, 2000);
});
