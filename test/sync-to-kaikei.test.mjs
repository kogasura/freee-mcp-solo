// `sync-to-kaikei.mjs` の解釈と変換の検査。
//
// freee を叩かない部分（テキストの解釈と仕訳への変換）だけを見る。

import test from "node:test";
import assert from "node:assert/strict";
import { parseDeals, toEntry } from "../tools/sync-to-kaikei.mjs";

const WITH_PARTNER =
  "#1 (id:123) 06-15 支出 ¥1,200 消耗品費 / 食料品 [モバイルSuica] <tax:2> <partner:イオンリテール>";
const WITHOUT_PARTNER =
  "#2 (id:124) 06-16 支出 ¥500 消耗品費 / 文具 [モバイルSuica] <tax:136>";
const PARTNER_ONLY =
  "#3 (id:125) 06-17 収入 ¥550,000 売上高 [ＰａｙＰａｙ銀行（API）] <tax:129> <partner:JDF株式会社>";

// **本命。** 取引先が摘要に混ざらない。
//
// 以前は `科目 / 摘要 / 取引先` の並びで出していたため、同期側が
// `parts.slice(1)` をすべて摘要として読み、実帳簿の 47 件で摘要が
// 「食料品 / イオンリテール」になっていた。
test("取引先は摘要と別に取れる", () => {
  const [deal] = parseDeals(WITH_PARTNER, 2026);
  assert.equal(deal.description, "食料品");
  assert.equal(deal.partner, "イオンリテール");
  assert.equal(deal.date, "2026-06-15");
  assert.equal(deal.amount, 1200);
});

test("取引先が無い行も読める", () => {
  const [deal] = parseDeals(WITHOUT_PARTNER, 2026);
  assert.equal(deal.partner, "");
  assert.equal(deal.description, "文具");
});

// 摘要が無く取引先だけある行。位置で決めていたときに取り違えていた形。
test("摘要が無く取引先だけある行を取り違えない", () => {
  const [deal] = parseDeals(PARTNER_ONLY, 2026);
  assert.equal(deal.description, "", "摘要は空");
  assert.equal(deal.partner, "JDF株式会社");
  assert.equal(deal.account, "売上高");
});

// **本命。** 取引先が counterparty タグとして仕訳に載る。
test("取引先が counterparty タグになる", () => {
  const [deal] = parseDeals(PARTNER_ONLY, 2026);
  const entry = toEntry(deal);
  for (const line of entry.lines) {
    assert.equal(line.tags.counterparty, "jdf", JSON.stringify(line));
  }
});

test("取引先が無ければ counterparty タグを付けない", () => {
  const [deal] = parseDeals(WITHOUT_PARTNER, 2026);
  const entry = toEntry(deal);
  for (const line of entry.lines) {
    assert.equal(line.tags.counterparty, undefined);
  }
});

// **黙って落とさない。** 対応表に無い取引先は変換を止める。
// 落とすと、適格請求書が要る税区分なのに相手方が辿れない仕訳が増える。
test("対応表に無い取引先はエラーになる", () => {
  const line =
    "#9 (id:999) 06-15 支出 ¥100 消耗品費 [モバイルSuica] <tax:136> <partner:知らない会社>";
  const [deal] = parseDeals(line, 2026);
  assert.throws(() => toEntry(deal), /知らない会社/);
});

// 表記ゆれで別登録されているものは同じコードに寄せてある。
test("表記ゆれの取引先は同じコードになる", () => {
  const withSpace =
    "#1 (id:1) 06-15 収入 ¥100 売上高 [モバイルSuica] <tax:129> <partner:株式会社 ビーテック>";
  const withoutSpace =
    "#2 (id:2) 06-15 収入 ¥100 売上高 [モバイルSuica] <tax:129> <partner:株式会社ビーテック>";
  const a = toEntry(parseDeals(withSpace, 2026)[0]);
  const b = toEntry(parseDeals(withoutSpace, 2026)[0]);
  assert.equal(a.lines[0].tags.counterparty, "bitech");
  assert.equal(b.lines[0].tags.counterparty, "bitech");
});

// freee の取引IDは残す（再実行時の重複判定に使う）。
test("freee の取引IDがタグに残る", () => {
  const [deal] = parseDeals(WITH_PARTNER, 2026);
  const entry = toEntry(deal);
  for (const line of entry.lines) {
    assert.equal(line.tags.imported_tx_id, "123");
  }
});

// ─── list_deals の出力と同期側の読み取りが食い違わないこと ───────────
//
// **これが無いと両者が別々に書かれたまま静かにずれる。** 実際、
// list_deals は `科目 / 摘要 / 取引先` の順で出していたのに、同期側は
// 取引先の存在を知らずに全部を摘要として読んでいた。

import { formatDealLine } from "../dist/tools/list-deals.js";

function row(overrides) {
  return {
    dealId: 123,
    date: "2026-06-15",
    type: "expense",
    amount: 1200,
    accountName: "消耗品費",
    description: "食料品",
    partnerName: "イオンリテール",
    walletName: "モバイルSuica",
    taxCode: 136,
    ...overrides,
  };
}

test("list_deals が出した行を同期側がそのまま読める", () => {
  const cases = [
    row({}),
    row({ description: "" }),
    row({ partnerName: "" }),
    row({ description: "", partnerName: "" }),
    row({ description: "A / B", partnerName: "Amazon" }),
  ];
  for (const source of cases) {
    const line = formatDealLine(source, 1);
    const [deal] = parseDeals(line, 2026);
    assert.ok(deal, `読めなかった: ${line}`);
    assert.equal(deal.id, String(source.dealId), line);
    assert.equal(deal.amount, source.amount, line);
    assert.equal(deal.account, source.accountName, line);
    assert.equal(deal.description, source.description, line);
    assert.equal(deal.partner, source.partnerName, line);
    assert.equal(deal.wallet, source.walletName, line);
    assert.equal(deal.tax_code, source.taxCode, line);
  }
});
