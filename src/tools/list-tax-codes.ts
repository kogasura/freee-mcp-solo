import { FreeeClient } from "../api/freee-client.js";

/**
 * 税区分コードの一覧。
 *
 * `list_deals` が返す `<tax:136>` のようなコードは数値なので、それだけでは
 * 意味が分からない。他ソフトへ仕訳を移すときに写像を作る必要があり、
 * **コードと名称の対応が要る**。
 *
 * 令和8年度税制改正で48件（231〜278）が追加されている
 * （freee Developers「[freee会計] API仕様の変更について（税区分）」2026-07-17）
 * ので、コード範囲を決め打ちにせず API から取る。
 */
interface TaxCode {
  code: number;
  name: string;
  name_ja?: string;
  display_category?: string;
  available?: boolean;
}

interface TaxCodesResponse {
  taxes: TaxCode[];
}

interface ListTaxCodesParams {
  /** コードで絞り込む（カンマ区切り）。指定した順ではなくコード順に返す。 */
  codes?: string;
  /** 名称の部分一致で絞り込む。 */
  keyword?: string;
}

export async function listTaxCodes(
  client: FreeeClient,
  params: ListTaxCodesParams
): Promise<string> {
  const res = await client.get<TaxCodesResponse>("/api/1/taxes/codes");
  const all = res.taxes ?? [];

  let rows = all;

  if (params.codes) {
    const wanted = new Set(
      params.codes
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n))
    );
    rows = rows.filter((t) => wanted.has(t.code));
    // **指定したコードが1つも見つからないことを黙って空にしない。**
    // 写像を作る側は「そのコードは存在しない」と「絞り込みを間違えた」を
    // 区別する必要がある。
    const missing = [...wanted].filter((c) => !rows.some((t) => t.code === c));
    if (missing.length > 0) {
      return (
        `指定したコードのうち ${missing.join(", ")} は税区分一覧にありません` +
        `（全 ${all.length} 件を確認）。コードを確認してください。`
      );
    }
  }

  if (params.keyword) {
    const keyword = params.keyword;
    rows = rows.filter(
      (t) =>
        (t.name ?? "").includes(keyword) || (t.name_ja ?? "").includes(keyword)
    );
  }

  if (rows.length === 0) {
    return `該当する税区分はありません（全 ${all.length} 件）`;
  }

  rows.sort((a, b) => a.code - b.code);

  const lines: string[] = [];
  lines.push(`## 税区分コード: ${rows.length}件（全 ${all.length} 件）`);
  lines.push("");
  for (const tax of rows) {
    const name = tax.name_ja || tax.name || "(名称なし)";
    const category = tax.display_category ? ` [${tax.display_category}]` : "";
    // 使えなくなった区分も隠さない。過去の仕訳に付いているコードは、
    // 今は使えなくても意味を知る必要がある。
    const availability = tax.available === false ? " (現在は選択不可)" : "";
    lines.push(`${tax.code}: ${name}${category}${availability}`);
  }
  return lines.join("\n");
}
