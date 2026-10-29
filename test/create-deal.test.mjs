// 明細からの登録の検査。
//
// **口座明細がある取引を POST /api/1/deals で登録すると、明細は「未処理」のまま残る。**
// 2026-10 に未処理が199件たまり、「自動で経理」の画面で登録を押すと二重計上に
// なる状態だった（2025年の二重計上23件と同じ形）。create_deal は日付・金額・
// 向きが一致する未処理の明細を探し、あればそこから登録する。

import test from "node:test";
import assert from "node:assert/strict";
import { pickWalletTxn, buildWalletTxnDealBody, findProcessedTwin } from "../dist/tools/create-deal.js";

function txn(overrides = {}) {
  return {
    id: 2516462023,
    date: "2026-10-26",
    entry_side: "expense",
    amount: 1604,
    due_amount: 1604,
    balance: 0,
    description: "ＡＱＵＡ  ＶＯＩＣＥ",
    walletable_type: "credit_card",
    walletable_id: 1861351,
    status: 1,
    ...overrides,
  };
}

const target = { date: "2026-10-26", amount: 1604, type: "expense" };

test("日付・金額・向きが一致する未処理の明細を選ぶ", () => {
  assert.equal(pickWalletTxn([txn()], target)?.id, 2516462023);
});

// 消込済みの明細に重ねて登録すると、同じ支払いが2回入る
test("消込済みの明細は選ばない", () => {
  assert.equal(pickWalletTxn([txn({ status: 2 })], target), undefined);
});

test("金額が違えば選ばない", () => {
  assert.equal(pickWalletTxn([txn({ amount: 1605 })], target), undefined);
});

test("日付が違えば選ばない", () => {
  assert.equal(pickWalletTxn([txn({ date: "2026-10-25" })], target), undefined);
});

// 返金（入金）と同額の支払い（出金）が同じ日にあることがある（ムームードメインで実際にあった）
test("入出金の向きが違えば選ばない", () => {
  assert.equal(pickWalletTxn([txn({ entry_side: "income" })], target), undefined);
  assert.equal(
    pickWalletTxn([txn({ entry_side: "income" })], { ...target, type: "income" })?.id,
    2516462023
  );
});

test("同じ日・同じ金額が複数あれば未処理の先頭を使う", () => {
  const picked = pickWalletTxn(
    [txn({ id: 1, status: 2 }), txn({ id: 2 }), txn({ id: 3 })],
    target
  );
  assert.equal(picked?.id, 2);
});

test("明細から登録するボディは deal_lines の1行で作る", () => {
  const body = buildWalletTxnDealBody({
    issue_date: "2026-10-26",
    amount: 1604,
    account_item_id: 623306499,
    tax_code: 136,
    partner_id: 120686345,
    description: "Aqua Voice（音声入力ツール）",
  });
  assert.deepEqual(body, {
    issue_date: "2026-10-26",
    partner_id: 120686345,
    deal_lines: [
      {
        account_item_id: 623306499,
        tax_code: 136,
        amount: 1604,
        description: "Aqua Voice（音声入力ツール）",
      },
    ],
  });
});

// API は additionalProperties: false。未定義の項目を送ると 400 になる
test("取引先・摘要が無ければ項目ごと送らない", () => {
  const body = buildWalletTxnDealBody({
    issue_date: "2026-10-26",
    amount: 1604,
    account_item_id: 623306499,
    tax_code: 136,
  });
  assert.equal("partner_id" in body, false);
  assert.equal("description" in body.deal_lines[0], false);
});

// 前回の呼び出しが登録まで終わってから失敗を返し、同じ引数で呼び直された形。
// 通常登録へ進むと同じ支払いが2回入る
test("処理済みの同じ明細があれば見つける", () => {
  assert.equal(findProcessedTwin([txn({ status: 2 })], target)?.id, 2516462023);
  assert.equal(findProcessedTwin([txn({ status: 3 })], target)?.id, 2516462023);
});

test("未処理の明細や、金額・向きの違う処理済み明細は双子とみなさない", () => {
  assert.equal(findProcessedTwin([txn({ status: 1 })], target), undefined);
  assert.equal(findProcessedTwin([txn({ status: 2, amount: 999 })], target), undefined);
  assert.equal(findProcessedTwin([txn({ status: 2, entry_side: "income" })], target), undefined);
});
