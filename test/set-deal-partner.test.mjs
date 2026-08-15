// 取引更新の本文組み立てと、更新後の照合の検査。
//
// freee を叩かない部分だけを見る。**全置換 API なので、写し漏れがそのまま
// データの欠落になる。** ここで固定しているのは「何を必ず写すか」である。

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildUpdateBody,
  whatChangedBesidesPartner,
} from "../dist/tools/set-deal-partner.js";

function deal(overrides = {}) {
  return {
    id: 3692454059,
    company_id: 10073516,
    issue_date: "2026-06-01",
    due_date: null,
    type: "expense",
    amount: 4309,
    partner_id: null,
    ref_number: "",
    status: "settled",
    details: [
      {
        id: 10055657456,
        account_item_id: 623306499,
        tax_code: 136,
        partner_id: 0,
        amount: 4309,
        vat: 391,
        description: "ムームードメイン by GMOペパボ",
        entry_side: "debit",
      },
    ],
    payments: [
      {
        id: 10055657458,
        date: "2026-06-01",
        from_walletable_type: "credit_card",
        from_walletable_id: 1861351,
        amount: 4309,
      },
    ],
    ...overrides,
  };
}

// **本命。** 明細を必ず載せる。渡さないと freee 側で消える。
test("明細をそのまま写す", () => {
  const body = buildUpdateBody(deal(), 120686330);
  assert.equal(body.details.length, 1);
  const detail = body.details[0];
  assert.equal(detail.id, 10055657456, "既存の明細IDを渡さないと作り直しになる");
  assert.equal(detail.account_item_id, 623306499);
  assert.equal(detail.tax_code, 136);
  assert.equal(detail.amount, 4309);
  assert.equal(detail.vat, 391);
  assert.equal(detail.description, "ムームードメイン by GMOペパボ");
  assert.equal(detail.entry_side, "debit");
});

// **本命。** 決済を必ず載せる。渡さないと決済済みが未決済に戻り、
// 口座明細との紐付けが外れる。
test("決済をそのまま写す", () => {
  const body = buildUpdateBody(deal(), 120686330);
  assert.equal(body.payments.length, 1);
  assert.equal(body.payments[0].id, 10055657458);
  assert.equal(body.payments[0].amount, 4309);
  assert.equal(body.payments[0].from_walletable_type, "credit_card");
  assert.equal(body.payments[0].from_walletable_id, 1861351);
});

test("変えるのは取引先だけ", () => {
  const body = buildUpdateBody(deal(), 120686330);
  assert.equal(body.partner_id, 120686330);
  assert.equal(body.issue_date, "2026-06-01");
  assert.equal(body.type, "expense");
  assert.equal(body.company_id, 10073516);
});

test("決済が無い取引では payments を送らない", () => {
  const body = buildUpdateBody(deal({ payments: [] }), 1);
  assert.equal(body.payments, undefined);
});

test("摘要が空でも空文字で送る", () => {
  const source = deal();
  source.details[0].description = undefined;
  const body = buildUpdateBody(source, 1);
  assert.equal(body.details[0].description, "");
});

// ─── 更新後の照合 ────────────────────────────────────────

test("取引先だけが変わっていれば問題なしと言う", () => {
  const before = deal();
  const after = deal({ partner_id: 120686330 });
  assert.deepEqual(whatChangedBesidesPartner(before, after), []);
});

// **本命。** 明細が消えたことを見逃さない。
test("明細が消えたら気づく", () => {
  const before = deal();
  const after = deal({ partner_id: 1, details: [] });
  const problems = whatChangedBesidesPartner(before, after);
  assert.ok(
    problems.some((text) => text.includes("明細の件数")),
    problems.join("、")
  );
});

// **本命。** 決済が外れたことを見逃さない。
test("決済が外れたら気づく", () => {
  const before = deal();
  const after = deal({ partner_id: 1, payments: [] });
  const problems = whatChangedBesidesPartner(before, after);
  assert.ok(
    problems.some((text) => text.includes("決済の件数")),
    problems.join("、")
  );
});

test("決済済みが未決済に戻ったら気づく", () => {
  const before = deal();
  const after = deal({ partner_id: 1, status: "unsettled" });
  const problems = whatChangedBesidesPartner(before, after);
  assert.ok(problems.some((text) => text.includes("状態")), problems.join("、"));
});

test("金額・科目・税区分・摘要の変化に気づく", () => {
  const before = deal();
  for (const [field, value] of [
    ["amount", 1],
    ["account_item_id", 999],
    ["tax_code", 2],
    ["description", "別の摘要"],
  ]) {
    const after = deal({ partner_id: 1 });
    after.details[0][field] = value;
    const problems = whatChangedBesidesPartner(before, after);
    assert.notEqual(problems.length, 0, `${field} の変化を見逃した`);
  }
});
