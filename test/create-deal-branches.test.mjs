// create_deal の分岐の検査（取引先・プライベート資金・未決済・メモタグ）。

import test from "node:test";
import assert from "node:assert/strict";
import { createDeal } from "../dist/tools/create-deal.js";

const ACCOUNTS = {
  通信費: { id: 1, name: "通信費", default_tax_code: 136 },
  地代家賃: { id: 2, name: "地代家賃", default_tax_code: 37 },
  事業主借: { id: 3, name: "事業主借", default_tax_code: 2 },
  事業主貸: { id: 4, name: "事業主貸", default_tax_code: 2 },
};

function fakes({ partner = null } = {}) {
  const posts = [];
  const client = {
    async get(path) {
      if (path === "/api/1/wallet_txns") return { wallet_txns: [] };
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path, body) {
      posts.push({ path, body });
      return { deal: { id: 55 } };
    },
  };
  const cache = {
    async resolveAccountItem(name) {
      return ACCOUNTS[name] ? { item: ACCOUNTS[name] } : { candidates: [] };
    },
    async resolvePartner() {
      return partner;
    },
    async createPartner(name) {
      posts.push({ path: "/api/1/partners", body: { name } });
      return { id: 9, name };
    },
    async resolveWalletable() {
      return null;
    },
    async getWalletables() {
      return [];
    },
    async getMemoTagId() {
      return 7;
    },
  };
  return { client, cache, posts };
}

const base = { type: "expense", issue_date: "2026-09-28", amount: 252500, account_item: "地代家賃" };

// 打ち間違いのたびに取引先が増えるのを防ぐ
test("未登録の取引先は、頼まれない限り作らず、取引も登録しない", async () => {
  const { client, cache, posts } = fakes();
  const out = await createDeal(client, cache, { ...base, partner_name: "東急住宅リースx" });
  assert.equal(posts.length, 0);
  assert.match(out, /未登録/);
});

test("create_partner: true なら取引先を作って登録する", async () => {
  const { client, cache, posts } = fakes();
  await createDeal(client, cache, { ...base, partner_name: "東急住宅リース", create_partner: true });
  assert.deepEqual(posts.map((p) => p.path), ["/api/1/partners", "/api/1/deals"]);
});

test("プライベート資金の支出は事業主借で決済する", async () => {
  const { client, cache, posts } = fakes();
  await createDeal(client, cache, { ...base, wallet_name: "プライベート資金" });
  assert.deepEqual(posts[0].body.payments, [
    { date: "2026-09-28", from_walletable_type: "private_account_item", from_walletable_id: 3, amount: 252500 },
  ]);
});

test("プライベート資金の収入は事業主貸で受け取る", async () => {
  const { client, cache, posts } = fakes();
  await createDeal(client, cache, { ...base, type: "income", wallet_name: "プライベート資金" });
  assert.equal(posts[0].body.payments[0].from_walletable_id, 4);
});

// 年末に売掛金を立てる用途で使う
test("口座を指定しなければ未決済のまま登録する", async () => {
  const { client, cache, posts } = fakes();
  const out = await createDeal(client, cache, base);
  assert.equal("payments" in posts[0].body, false);
  assert.match(out, /未決済/);
});

test("登録する取引の明細行にメモタグを付ける", async () => {
  const { client, cache, posts } = fakes();
  await createDeal(client, cache, base);
  assert.deepEqual(posts[0].body.details[0].tag_ids, [7]);
});
