// 勘定科目の差し替えの検査。
//
// **全置換 API なので、写し漏れがそのままデータの欠落になる。**
// ここで固定しているのは「科目だけが変わり、他は何も変わらない」ことである。
//
// 実際に踏んだ形: 2026-03-26 のカード引落し 90,057円 が「未払金」ではなく
// 「事業主貸」に計上されていた。他の月（1・2・5・6・7月）はすべて未払金で、
// この月だけが例外だった。**貸借は一致したままなので決算書を見ても分からない。**

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAccountUpdateBody,
  whatChangedBesidesAccount,
} from "../dist/tools/set-deal-account.js";

const 事業主貸 = 623306400;
const 未払金 = 623306500;

function deal(overrides = {}) {
  return {
    id: 3660904261,
    company_id: 10073516,
    issue_date: "2026-03-26",
    due_date: null,
    type: "expense",
    amount: 90057,
    partner_id: 120686330,
    ref_number: "",
    status: "settled",
    details: [
      {
        id: 10055657456,
        account_item_id: 事業主貸,
        tax_code: 2,
        amount: 90057,
        vat: 0,
        description: "クレジットカード引落",
        entry_side: "debit",
      },
    ],
    payments: [
      {
        id: 10055657458,
        date: "2026-03-26",
        from_walletable_type: "bank_account",
        from_walletable_id: 1861350,
        amount: 90057,
      },
    ],
    ...overrides,
  };
}

// **本命。** 科目だけが変わる。
test("勘定科目を差し替える", () => {
  const body = buildAccountUpdateBody(deal(), 未払金);
  assert.equal(body.details.length, 1);
  assert.equal(body.details[0].account_item_id, 未払金);
});

// **本命。** 明細の他の属性はそのまま写す。
//
// 渡さないと freee 側で消える。金額や税区分が消えれば取引が壊れる。
test("明細の他の属性は変えない", () => {
  const detail = buildAccountUpdateBody(deal(), 未払金).details[0];
  assert.equal(detail.id, 10055657456, "明細IDを渡さないと作り直しになる");
  assert.equal(detail.tax_code, 2);
  assert.equal(detail.amount, 90057);
  assert.equal(detail.vat, 0);
  assert.equal(detail.description, "クレジットカード引落");
  assert.equal(detail.entry_side, "debit");
});

// **本命。** 決済を落とさない。
//
// 渡さないと決済済みの取引が未決済に戻り、口座明細との紐付けが外れる。
test("決済をそのまま写す", () => {
  const body = buildAccountUpdateBody(deal(), 未払金);
  assert.equal(body.payments.length, 1);
  assert.equal(body.payments[0].id, 10055657458);
  assert.equal(body.payments[0].amount, 90057);
  assert.equal(body.payments[0].from_walletable_id, 1861350);
});

// **本命。** 取引先を落とさない。
test("取引先はそのまま", () => {
  const body = buildAccountUpdateBody(deal(), 未払金);
  assert.equal(body.partner_id, 120686330);
});

// 取引先が無い取引では、キーごと落とす（0 を送ると別の意味になる）。
test("取引先が無ければ partner_id を送らない", () => {
  const body = buildAccountUpdateBody(deal({ partner_id: null }), 未払金);
  assert.ok(!("partner_id" in body), JSON.stringify(body));
});

// 明細が複数ある取引は、すべての明細に同じ科目が当たる。
//
// **だから実装側で断っている**（どの明細を差し替えるか決められない）。
// この検査は、断りを外したときに何が起きるかを見えるようにするためのもの。
test("明細が複数なら全部に同じ科目が当たる（だから実装側で断る）", () => {
  const two = deal({
    details: [
      { ...deal().details[0], id: 1 },
      { ...deal().details[0], id: 2, amount: 100 },
    ],
  });
  const body = buildAccountUpdateBody(two, 未払金);
  assert.equal(body.details[0].account_item_id, 未払金);
  assert.equal(body.details[1].account_item_id, 未払金, "巻き添えになる");
});

// ─── 更新後の照合 ───────────────────────────────

// **本命。** 科目が変わっただけなら何も言わない。
test("科目だけ変わったなら問題なし", () => {
  const before = deal();
  const after = deal({
    details: [{ ...deal().details[0], account_item_id: 未払金 }],
  });
  assert.deepEqual(whatChangedBesidesAccount(before, after), []);
});

// **本命。** 決済が消えたら気づく。
test("決済が消えたら気づく", () => {
  const before = deal();
  const after = deal({ payments: [] });
  const problems = whatChangedBesidesAccount(before, after);
  assert.ok(problems.some((p) => p.includes("決済")), problems.join("/"));
});

// **本命。** 明細が消えたら気づく。
test("明細が消えたら気づく", () => {
  const before = deal();
  const after = deal({ details: [] });
  const problems = whatChangedBesidesAccount(before, after);
  assert.ok(problems.some((p) => p.includes("明細の件数")), problems.join("/"));
});

// **本命。** 取引先が消えたら気づく。
//
// 科目を直すついでに取引先を失うと、適格請求書の相手方が辿れなくなる。
test("取引先が消えたら気づく", () => {
  const before = deal();
  const after = deal({ partner_id: null });
  const problems = whatChangedBesidesAccount(before, after);
  assert.ok(problems.includes("取引先"), problems.join("/"));
});

test("金額が変わったら気づく", () => {
  const before = deal();
  const after = deal({
    details: [{ ...deal().details[0], amount: 1 }],
  });
  const problems = whatChangedBesidesAccount(before, after);
  assert.ok(problems.some((p) => p.includes("金額")), problems.join("/"));
});

test("税区分が変わったら気づく", () => {
  const before = deal();
  const after = deal({
    details: [{ ...deal().details[0], tax_code: 136 }],
  });
  const problems = whatChangedBesidesAccount(before, after);
  assert.ok(problems.some((p) => p.includes("税区分")), problems.join("/"));
});

// 科目の違いは「問題」に挙げない（それが変えたかったものである）。
test("科目の違いは問題として挙げない", () => {
  const before = deal();
  const after = deal({
    details: [{ ...deal().details[0], account_item_id: 未払金 }],
  });
  assert.ok(
    !whatChangedBesidesAccount(before, after).some((p) => p.includes("勘定科目")),
    "変えたかったものを問題にしない"
  );
});

// ─── 摘要の差し替え ─────────────────────────────

// **入金だけでは何月分の売上か分からない。** 年末に売掛金を立てるとき、
// 翌年1〜2月の入金から遡って当年分を特定するが、その手がかりが摘要である。
// 請求書は当てにできない（作っていないものがある）。

import {
  buildDescriptionUpdateBody,
  whatChangedBesidesDescription,
} from "../dist/tools/set-deal-account.js";

// **本命。** 摘要だけが変わる。
test("摘要を差し替える", () => {
  const body = buildDescriptionUpdateBody(deal(), "振込 カ）ビーテツク（6月分）");
  assert.equal(body.details[0].description, "振込 カ）ビーテツク（6月分）");
});

// **本命。** 科目・金額・税区分は変えない。
test("摘要の差し替えで他の属性を変えない", () => {
  const detail = buildDescriptionUpdateBody(deal(), "x").details[0];
  assert.equal(detail.id, 10055657456);
  assert.equal(detail.account_item_id, 事業主貸);
  assert.equal(detail.tax_code, 2);
  assert.equal(detail.amount, 90057);
});

// **本命。** 決済と取引先を落とさない。
test("摘要の差し替えで決済と取引先を落とさない", () => {
  const body = buildDescriptionUpdateBody(deal(), "x");
  assert.equal(body.payments.length, 1);
  assert.equal(body.payments[0].id, 10055657458);
  assert.equal(body.partner_id, 120686330);
});

// **本命。** 科目が変わったら気づく。
//
// 摘要を直すついでに科目を失うと、決算書の欄が変わる。
test("摘要以外が変わったら気づく", () => {
  const before = deal();
  const after = deal({
    details: [{ ...deal().details[0], account_item_id: 未払金 }],
  });
  const problems = whatChangedBesidesDescription(before, after);
  assert.ok(problems.some((p) => p.includes("勘定科目")), problems.join("/"));
});

// 摘要の違いは「問題」に挙げない（それが変えたかったものである）。
test("摘要の違いは問題として挙げない", () => {
  const before = deal();
  const after = deal({
    details: [{ ...deal().details[0], description: "新しい摘要" }],
  });
  assert.deepEqual(whatChangedBesidesDescription(before, after), []);
});
