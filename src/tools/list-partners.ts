import { FreeeClient } from "../api/freee-client.js";

/**
 * 取引先の一覧を出し、kaikei に取り込める CSV を添える。
 *
 * # なぜ要るのか
 *
 * kaikei の `counterparties` は空で、取引先タグを付けられない。仕訳に取引先が
 * 付いていないと、適格請求書が要る税区分でも「誰から受け取った請求書か」が
 * 帳簿から辿れない。freee には取引先が既に入っているので、それを写す。
 *
 * # 適格フラグを写さない
 *
 * freee の `qualified_invoice_issuer` が `false` でも、それは
 * **「非適格だと確認した」ではなく「誰も入力していない」**ことが多い。
 * この会社の 34 件は全件が `false` かつ登録番号 `null` だった。
 *
 * kaikei 側では `NULL`（未確認）と `false`（非適格だと確認した）が別の意味を
 * 持ち、`false` のときだけ記帳が拒まれる。だから **登録番号があって
 * `qualified_invoice_issuer` が真のときだけ `true` を出し、それ以外は空欄**
 * （未確認）にする。`false` は出さない。
 */
interface Partner {
  id: number;
  name: string;
  code?: string | null;
  available?: boolean;
  invoice_registration_number?: string | null;
  qualified_invoice_issuer?: boolean;
}

interface PartnersResponse {
  partners: Partner[];
}

interface ListPartnersParams {
  /** 使用停止の取引先も含める。既定は含めない。 */
  include_unavailable?: boolean;
}

/**
 * 取引先コードの候補を作る。
 *
 * freee 側の `code` があればそれを使う。無ければ名称の ASCII 部分から作る。
 * **日本語だけの名称からは作らない**——ローマ字化の当て方は一意でなく
 * （「大久保」= okubo / ohkubo / ookubo）、取引先コードは仕訳のタグとして
 * 帳簿に残り続けるので、後から変えると過去の仕訳が指す先が消える。
 * 決めるのは人であるべきなので、空欄にして kaikei 側で弾かれるようにする。
 */
export function suggestCode(partner: Partner): string {
  const existing = partner.code?.trim();
  if (existing) return existing;

  // 法人格の語は名前の一部ではないので落とす（「株式会社VISELINK」→
  // 「VISELINK」）。全角は NFKC で半角に寄せてから見る。
  const bare = partner.name
    .normalize("NFKC")
    .replace(/(株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|\(株\)|\(有\))/g, "")
    .trim();

  // **ASCII 以外が残っていたら作らない。** 「GMOペパボ」から ASCII だけを
  // 拾うと `gmo` になるが、GMO 系列は複数あるので別の取引先と区別できない。
  // 一部だけ拾った略称は、後から見て何のことか分からないだけでなく、
  // 取り違えたまま帳簿に残る。
  const isAscii = [...bare].every((ch) => ch.charCodeAt(0) < 128);
  if (!isAscii) return "";

  const ascii = bare
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // 1〜2文字は略称として使い物にならない。
  return ascii.length >= 3 ? ascii : "";
}

/**
 * kaikei に渡す `is_qualified` の値。**`false` は返さない。**
 */
export function qualifiedCell(partner: Partner): string {
  const hasNumber = Boolean(partner.invoice_registration_number?.trim());
  return hasNumber && partner.qualified_invoice_issuer === true ? "true" : "";
}

/** CSV の1セルを引用する（社名にカンマが入ることがある）。 */
function cell(text: string): string {
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function listPartners(
  client: FreeeClient,
  params: ListPartnersParams
): Promise<string> {
  const res = await client.get<PartnersResponse>("/api/1/partners", {
    limit: 3000,
  });
  const all = res.partners ?? [];
  const rows = params.include_unavailable
    ? all
    : all.filter((p) => p.available !== false);

  if (rows.length === 0) {
    return "取引先が登録されていません。";
  }

  const lines: string[] = [];
  lines.push(`取引先 ${rows.length} 件`);
  if (!params.include_unavailable && all.length !== rows.length) {
    lines.push(
      `（使用停止の ${all.length - rows.length} 件を除いています。include_unavailable で含められます）`
    );
  }

  const withNumber = rows.filter((p) =>
    p.invoice_registration_number?.trim()
  ).length;
  lines.push(
    `うち適格請求書発行事業者の登録番号が入っているもの: ${withNumber} 件`
  );
  if (withNumber === 0) {
    lines.push(
      "freee 側に登録番号が1件も入っていません。適格かどうかは未確認として扱います"
    );
    lines.push(
      "（freee の qualified_invoice_issuer が false でも、それは「非適格だと確認した」という意味ではありません）"
    );
  }

  const missingCode = rows.filter((p) => suggestCode(p) === "");
  lines.push("");
  lines.push("--- kaikei counterparty import 用の CSV（ここから） ---");
  lines.push("code,name,invoice_registration_no,is_qualified");
  for (const partner of rows) {
    lines.push(
      [
        cell(suggestCode(partner)),
        cell(partner.name),
        cell(partner.invoice_registration_number?.trim() ?? ""),
        qualifiedCell(partner),
      ].join(",")
    );
  }
  lines.push("--- ここまで ---");

  if (missingCode.length > 0) {
    lines.push("");
    lines.push(
      `※ ${missingCode.length} 件は code が空です。日本語だけの名称からコードを自動で作っていません`
    );
    lines.push(
      "  （ローマ字化の当て方が一意でなく、取引先コードは仕訳のタグとして帳簿に残り続けるためです）。"
    );
    lines.push("  空のまま取り込むと kaikei が行番号を出して止まります。埋めてから取り込んでください:");
    for (const partner of missingCode.slice(0, 20)) {
      lines.push(`    ${partner.name}`);
    }
    if (missingCode.length > 20) {
      lines.push(`    ... 他 ${missingCode.length - 20} 件`);
    }
  }

  return lines.join("\n");
}
