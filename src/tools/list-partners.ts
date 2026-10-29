import { FreeeClient } from "../api/freee-client.js";

/**
 * 取引先の一覧を出し、適格請求書発行事業者の登録番号が入っているかを示す。
 *
 * # なぜ要るのか
 *
 * 適格請求書が要る税区分の取引でも、取引先に登録番号が無いと、帳簿から
 * 仕入税額控除の根拠を辿れない。登録番号が抜けている取引先を洗い出す。
 *
 * # freee の適格フラグをそのまま信じない
 *
 * freee の `qualified_invoice_issuer` が `false` でも、それは
 * **「非適格だと確認した」ではなく「誰も入力していない」**ことが多い。
 * この会社の 34 件は全件が `false` かつ登録番号 `null` だった。
 * だから **登録番号があって `qualified_invoice_issuer` が真のときだけ「適格」**
 * とし、それ以外は「未確認」として出す。「非適格」とは言わない。
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
 * 適格請求書発行事業者かどうかの表示。**「非適格」は返さない。**
 */
export function qualifiedLabel(partner: Partner): "適格" | "未確認" {
  const hasNumber = Boolean(partner.invoice_registration_number?.trim());
  return hasNumber && partner.qualified_invoice_issuer === true ? "適格" : "未確認";
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

  lines.push("");
  for (const partner of rows) {
    const number = partner.invoice_registration_number?.trim();
    const code = partner.code?.trim();
    lines.push(
      `- ${partner.name} (id:${partner.id}${code ? ` code:${code}` : ""}) ` +
        `${qualifiedLabel(partner)}${number ? ` ${number}` : " 登録番号なし"}`
    );
  }

  return lines.join("\n");
}
