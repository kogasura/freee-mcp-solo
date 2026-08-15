// `list_partners` が作る取引先コードと適格フラグの検査。
//
// ビルド済みの `dist/` を読む（このリポジトリは tsc だけで、テスト用の
// トランスパイル経路を持たない）。先に `npm run build` を実行すること。

import test from "node:test";
import assert from "node:assert/strict";
import { suggestCode, qualifiedCell } from "../dist/tools/list-partners.js";

test("freee 側に code があればそれを使う", () => {
  assert.equal(suggestCode({ id: 1, name: "Anthropic", code: "ANT" }), "ANT");
});

test("法人格を落として ASCII の社名からコードを作る", () => {
  assert.equal(suggestCode({ id: 1, name: "株式会社VISELINK" }), "viselink");
  assert.equal(suggestCode({ id: 2, name: "JDF株式会社" }), "jdf");
  assert.equal(suggestCode({ id: 3, name: "Aqua Voice" }), "aqua-voice");
});

test("全角の英字は半角に寄せる", () => {
  assert.equal(suggestCode({ id: 1, name: "株式会社ＨｏｇＷｏｒｋｓ" }), "hogworks");
});

// **本命。** 一部だけ ASCII の名前からコードを作らない。
//
// 「GMOペパボ」から ASCII だけ拾うと `gmo` になるが、GMO 系列は複数あるので
// 別の取引先と区別できない。取引先コードは仕訳のタグとして帳簿に残り続ける。
test("ASCII 以外が残る社名からはコードを作らない", () => {
  assert.equal(suggestCode({ id: 1, name: "GMOペパボ" }), "");
  assert.equal(suggestCode({ id: 2, name: "東京電力" }), "");
  assert.equal(suggestCode({ id: 3, name: "株式会社ガリレオ・プロジェクト" }), "");
});

test("2文字以下の略称は作らない", () => {
  assert.equal(suggestCode({ id: 1, name: "AB" }), "");
});

// **本命。** freee の `false` を kaikei の「非適格だと確認した」にしない。
//
// kaikei では `false` のときだけ記帳が拒まれる。freee の 34 件は全件が
// `qualified_invoice_issuer: false` かつ登録番号 `null` だったが、これは
// 誰も入力していないという意味でしかない。
test("登録番号が無ければ適格フラグは空欄（未確認）", () => {
  assert.equal(
    qualifiedCell({ id: 1, name: "A", qualified_invoice_issuer: false }),
    ""
  );
  assert.equal(
    qualifiedCell({ id: 2, name: "B", qualified_invoice_issuer: true }),
    "",
    "登録番号が無いのに true にしない"
  );
  assert.equal(
    qualifiedCell({
      id: 3,
      name: "C",
      invoice_registration_number: "",
      qualified_invoice_issuer: true,
    }),
    ""
  );
});

test("登録番号があって適格なら true", () => {
  assert.equal(
    qualifiedCell({
      id: 1,
      name: "A",
      invoice_registration_number: "T1234567890123",
      qualified_invoice_issuer: true,
    }),
    "true"
  );
});

test("false は決して出さない", () => {
  const cases = [
    { id: 1, name: "A", qualified_invoice_issuer: false },
    {
      id: 2,
      name: "B",
      invoice_registration_number: "T1234567890123",
      qualified_invoice_issuer: false,
    },
  ];
  for (const partner of cases) {
    assert.notEqual(qualifiedCell(partner), "false", JSON.stringify(partner));
  }
});
