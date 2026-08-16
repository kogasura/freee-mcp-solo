// `sync-to-kaikei.mjs` の解釈と変換の検査。
//
// freee を叩かない部分（テキストの解釈と仕訳への変換）だけを見る。

import test from "node:test";
import assert from "node:assert/strict";
import { parseDeals, splitAlreadyPosted, toEntry } from "../tools/sync-to-kaikei.mjs";

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

// ─── 流し直したときの重複判定 ─────────────────────────────

// **これを間違えると帳簿が壊れる。** 追記型なので二重計上は逆仕訳でしか
// 消せない。実際、2025年の帳簿には二重計上が23件（1,420,182円）あった。

function entry(date, description, amount, txId) {
  const tags = txId ? { imported_tx_id: String(txId) } : {};
  return {
    entry_date: date,
    description,
    lines: [
      { account: "604", side: "debit", amount, tags },
      { account: "101", side: "credit", amount, tags },
    ],
  };
}

/** `existingEntries` が返す形を、仕訳の一覧から作る。 */
function existingFrom(entries) {
  const ids = new Set();
  const counts = new Map();
  for (const e of entries) {
    for (const l of e.lines) if (l.tags?.imported_tx_id) ids.add(l.tags.imported_tx_id);
    const key = `${e.entry_date}|${e.description}|${e.lines
      .map((l) => `${l.account}/${l.side}/${l.amount}`)
      .sort()
      .join(",")}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return { ids, counts };
}

// **本命。** 同じ月を流し直しても何も入らない。
test("流し直しても既にある仕訳は入らない", () => {
  const entries = [entry("2026-06-15", "食料品", 1200, 501), entry("2026-06-16", "文具", 500, 502)];
  const { fresh, alreadyPosted } = splitAlreadyPosted(entries, existingFrom(entries));

  assert.equal(fresh.length, 0);
  assert.equal(alreadyPosted, 2);
});

// **本命。** 取引IDが無い分は指紋で判定する。
//
// 実帳簿の2026年の仕訳 694件のうち 687件にこのタグが無い（後から足したため）。
// ID だけで判定すると、古い月を流し直したときに全件が二重計上になる。
test("取引IDが無くても指紋で既存と判定する", () => {
  const inBook = [entry("2026-06-15", "食料品", 1200, null)];
  const fromFreee = [entry("2026-06-15", "食料品", 1200, 501)];

  const { fresh, alreadyPosted } = splitAlreadyPosted(fromFreee, existingFrom(inBook));

  assert.equal(alreadyPosted, 1, "タグの有無で別物にしないこと");
  assert.equal(fresh.length, 0);
});

// **本命。** 摘要が変わると別物になる。
//
// 摘要の作り方を変えると、記帳済みの月が「未記帳」に見える。指紋は摘要を
// 含むので、変えたら流し直してはいけない。この検査はその性質を固定する。
test("摘要が違えば別の仕訳として扱う", () => {
  const inBook = [entry("2026-06-15", "食料品 イオンリテール", 1200, null)];
  const fromFreee = [entry("2026-06-15", "食料品", 1200, null)];

  const { fresh } = splitAlreadyPosted(fromFreee, existingFrom(inBook));

  assert.equal(fresh.length, 1, "摘要が違うので既存とは判定されない");
});

// **本命。** 同じ内容が複数あっても件数で釣り合わせる。
test("freeeに3件・帳簿に2件なら1件だけ記帳する", () => {
  const one = () => entry("2026-06-15", "交通費", 220, null);
  const inBook = [one(), one()];
  const fromFreee = [one(), one(), one()];

  const { fresh, alreadyPosted } = splitAlreadyPosted(fromFreee, existingFrom(inBook));

  assert.equal(alreadyPosted, 2);
  assert.equal(fresh.length, 1);
});

test("帳簿が空なら全件が新規", () => {
  const entries = [entry("2026-06-15", "食料品", 1200, 501)];
  const { fresh, alreadyPosted } = splitAlreadyPosted(entries, existingFrom([]));

  assert.equal(fresh.length, 1);
  assert.equal(alreadyPosted, 0);
});

// 取引IDが一致すれば、摘要が変わっていても同じ取引。
test("取引IDが一致すれば摘要が変わっていても既存", () => {
  const inBook = [entry("2026-06-15", "食料品 イオンリテール", 1200, 501)];
  const fromFreee = [entry("2026-06-15", "食料品", 1200, 501)];

  const { fresh, alreadyPosted } = splitAlreadyPosted(fromFreee, existingFrom(inBook));

  assert.equal(alreadyPosted, 1, "IDで判定できる分は摘要に左右されない");
  assert.equal(fresh.length, 0);
});

// **本命。** 摘要に取引先名が付いていた頃の仕訳を、既存として拾う。
//
// 2026年6月の実帳簿はこの形（`振込 ジエイデイーエフ（カ / JDF株式会社`）で
// 記帳されている。いまの同期は取引先名を摘要に入れないので、これを拾えないと
// **流し直しで二重計上**になる。実際 134件中12件が該当した。
test("摘要に取引先名が付いていた頃の仕訳を既存と判定する", () => {
  const withPartner = (description) => ({
    entry_date: "2026-06-10",
    description,
    lines: [
      { account: "101", side: "debit", amount: 1155000, tags: { counterparty: "jdf" } },
      { account: "500", side: "credit", amount: 1155000, tags: { counterparty: "jdf" } },
    ],
  });
  const inBook = [withPartner("振込 ジエイデイーエフ（カ / JDF株式会社")];
  const fromFreee = [withPartner("振込 ジエイデイーエフ（カ")];

  const { fresh, alreadyPosted } = splitAlreadyPosted(fromFreee, existingFrom(inBook));

  assert.equal(alreadyPosted, 1, "旧い形の摘要も同じ取引と見なすこと");
  assert.equal(fresh.length, 0);
});

// 取引先タグが無ければ、旧い形は探さない（無関係な仕訳を巻き込まない）。
test("取引先タグが無ければ旧い形は探さない", () => {
  const inBook = [entry("2026-06-10", "交通費 / JDF株式会社", 220, null)];
  const fromFreee = [entry("2026-06-10", "交通費", 220, null)];

  const { fresh } = splitAlreadyPosted(fromFreee, existingFrom(inBook));

  assert.equal(fresh.length, 1, "取引先タグが無い分まで拾わないこと");
});
