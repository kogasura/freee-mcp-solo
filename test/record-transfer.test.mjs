// 口座振替の登録の検査。
//
// **両側に明細がある口座どうしでは、freee は片方の明細から振替を作り、反対側は
// 未処理のまま残る。** 呼び直すとその明細から2本目の振替ができ、カードの残高が
// 二重に減る（レビューで見つかった経路）。処理済みの同じ明細・同じ振替があれば止める。
//
// API は additionalProperties: false。from_line に amount を付けると 400 になり、
// 摘要は振替先の行に入れないと null になる（どちらも 2026-10-29 に実測）。

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTransferFromWalletTxnBody,
  findSameTransfer,
  recordTransfer,
} from "../dist/tools/record-transfer.js";

const bank = { type: "bank_account", id: 2913607, name: "PayPay銀行" };
const card = { type: "credit_card", id: 1861351, name: "三井住友MASTERカード" };

function fakes({ bankTxns = [], cardTxns = [], transfers = [] } = {}) {
  const posts = [];
  const client = {
    async get(path, params) {
      if (path === "/api/1/wallet_txns") {
        return { wallet_txns: params.walletable_id === bank.id ? bankTxns : cardTxns };
      }
      if (path === "/api/1/transfers") return { transfers };
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path, body) {
      posts.push({ path, body });
      return path.endsWith("/create_transfer") ? { transfer_ids: [1] } : { transfer: { id: 2 } };
    },
  };
  const cache = {
    async resolveWalletable(name) {
      return name.includes("PayPay") ? bank : name.includes("三井住友") ? card : null;
    },
    async getWalletables() {
      return [bank, card];
    },
    async getMemoTagId() {
      return 7;
    },
  };
  return { client, cache, posts };
}

const params = { date: "2026-09-28", amount: 60430, from: "PayPay銀行", to: "三井住友" };
const txn = (o) => ({
  id: 101,
  date: "2026-09-28",
  amount: 60430,
  entry_side: "expense",
  walletable_type: "bank_account",
  walletable_id: bank.id,
  status: 1,
  ...o,
});

test("振替元には金額を付けず、振替先に金額と摘要を付ける", () => {
  const body = buildTransferFromWalletTxnBody({ from: bank, to: card, amount: 60430, description: "引落し" });
  assert.deepEqual(body.transfer_from_line, { walletable_type: "bank_account", walletable_id: 2913607 });
  assert.deepEqual(body.transfer_to_lines, [
    { walletable_type: "credit_card", walletable_id: 1861351, amount: 60430, description: "引落し" },
  ]);
});

test("出金側の未処理明細から振替を作る", async () => {
  const { client, cache, posts } = fakes({ bankTxns: [txn()] });
  const out = await recordTransfer(client, cache, params);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, "/api/1/wallet_txns/101/create_transfer");
  assert.match(out, /紐付け済み/);
});

// **本命。** 1回目で銀行側が処理済みになり、カード側が未処理で残った状態での呼び直し
test("反対側に処理済みの同じ明細があれば、未処理側から2本目を作らない", async () => {
  const { client, cache, posts } = fakes({
    bankTxns: [txn({ status: 2 })],
    cardTxns: [txn({ id: 201, entry_side: "income", walletable_type: "credit_card", walletable_id: card.id })],
  });
  const out = await recordTransfer(client, cache, params);
  assert.equal(posts.length, 0);
  assert.match(out, /登録を止めました/);
});

// 明細の取り込み前に POST /transfers で作り、後から明細が届いた状態での呼び直し
test("同じ日・同じ金額・同じ向きの振替がすでにあれば作らない", async () => {
  const { client, cache, posts } = fakes({
    bankTxns: [txn()],
    transfers: [{
      id: 9, date: "2026-09-28", amount: 60430,
      from_walletable_type: "bank_account", from_walletable_id: bank.id,
      to_walletable_type: "credit_card", to_walletable_id: card.id,
    }],
  });
  const out = await recordTransfer(client, cache, params);
  assert.equal(posts.length, 0);
  assert.match(out, /すでにあります/);
});

test("逆向きの振替は同じ振替とみなさない", () => {
  const t = [{
    id: 9, date: "2026-09-28", amount: 60430,
    from_walletable_type: "credit_card", from_walletable_id: card.id,
    to_walletable_type: "bank_account", to_walletable_id: bank.id,
  }];
  assert.equal(findSameTransfer(t, { date: "2026-09-28", amount: 60430, from: bank, to: card }), undefined);
});

test("明細が無ければ通常の振替を作り、紐付いていないと伝える", async () => {
  const { client, cache, posts } = fakes();
  const out = await recordTransfer(client, cache, params);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, "/api/1/transfers");
  assert.match(out, /紐付いていません/);
});
