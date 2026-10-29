// `list_partners` の適格表示の検査。
//
// ビルド済みの `dist/` を読む（このリポジトリは tsc だけで、テスト用の
// トランスパイル経路を持たない）。先に `npm run build` を実行すること。

import test from "node:test";
import assert from "node:assert/strict";
import { qualifiedLabel } from "../dist/tools/list-partners.js";

// **本命。** freee の `false` を「非適格だと確認した」にしない。
//
// freee の 34 件は全件が `qualified_invoice_issuer: false` かつ登録番号 `null`
// だったが、これは誰も入力していないという意味でしかない。
test("登録番号が無ければ未確認", () => {
  assert.equal(
    qualifiedLabel({ id: 1, name: "A", qualified_invoice_issuer: false }),
    "未確認"
  );
  assert.equal(
    qualifiedLabel({ id: 2, name: "B", qualified_invoice_issuer: true }),
    "未確認",
    "登録番号が無いのに適格にしない"
  );
  assert.equal(
    qualifiedLabel({
      id: 3,
      name: "C",
      invoice_registration_number: "",
      qualified_invoice_issuer: true,
    }),
    "未確認"
  );
});

test("登録番号があって適格なら適格", () => {
  assert.equal(
    qualifiedLabel({
      id: 1,
      name: "A",
      invoice_registration_number: "T1234567890123",
      qualified_invoice_issuer: true,
    }),
    "適格"
  );
});

test("登録番号があっても freee の適格フラグが false なら未確認", () => {
  assert.equal(
    qualifiedLabel({
      id: 2,
      name: "B",
      invoice_registration_number: "T1234567890123",
      qualified_invoice_issuer: false,
    }),
    "未確認"
  );
});
