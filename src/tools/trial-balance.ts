import { FreeeClient } from "../api/freee-client.js";

/**
 * 貸借対照表（試算表）。
 *
 * `list_deals` や `monthly_summary` は**取引**を集めたものなので、取引として
 * 記録されない **期首残高**が出てこない。他ソフトへ帳簿を移すときは期首残高が
 * 無いと残高が合わない（現金がマイナスになる、といった形で表面化する）ため、
 * freee 自身の集計であるこの API から取る。
 *
 * freee の応答は科目ごとに
 * `opening_balance`（期首）/ `debit_amount`（借方）/ `credit_amount`（貸方）/
 * `closing_balance`（期末）を持つ。
 */
interface TrialBalanceRow {
  account_item_id?: number;
  account_item_name?: string;
  /** 科目グループの見出し行（合計行）にはこれが入る。 */
  hierarchy_level?: number;
  parent_account_category_name?: string;
  opening_balance?: number;
  debit_amount?: number;
  credit_amount?: number;
  closing_balance?: number;
  total_line?: boolean;
}

interface TrialBalanceResponse {
  trial_bs: {
    company_id: number;
    start_date: string;
    end_date: string;
    balances: TrialBalanceRow[];
  };
}

interface TrialBalanceParams {
  /** 会計年度（例: 2026）。 */
  fiscal_year?: number;
  /** 開始月（1-12）。省略時は 1。 */
  start_month?: number;
  /** 終了月（1-12）。省略時は開始月と同じ。 */
  end_month?: number;
  /** 残高が 0 の科目も出す。既定は出さない。 */
  include_zero?: boolean;
}

function yen(value: number | undefined): string {
  return (value ?? 0).toLocaleString("ja-JP");
}

export async function trialBalance(
  client: FreeeClient,
  params: TrialBalanceParams
): Promise<string> {
  const now = new Date();
  const fiscalYear = params.fiscal_year ?? now.getFullYear();
  const startMonth = params.start_month ?? 1;
  const endMonth = params.end_month ?? startMonth;

  const query = new URLSearchParams({
    fiscal_year: String(fiscalYear),
    start_month: String(startMonth),
    end_month: String(endMonth),
  });
  const res = await client.get<TrialBalanceResponse>(
    `/api/1/reports/trial_bs?${query.toString()}`
  );

  const report = res.trial_bs;
  if (!report) {
    return "貸借対照表を取得できませんでした（応答に trial_bs がありません）。";
  }

  // 合計行・見出し行は除く。**科目名の無い行も落とす**——集計行を明細に
  // 混ぜると、読む側が二重に数えてしまう。
  const rows = (report.balances ?? []).filter(
    (r) => r.account_item_name && !r.total_line
  );

  const shown = params.include_zero
    ? rows
    : rows.filter(
        (r) =>
          (r.opening_balance ?? 0) !== 0 ||
          (r.debit_amount ?? 0) !== 0 ||
          (r.credit_amount ?? 0) !== 0 ||
          (r.closing_balance ?? 0) !== 0
      );

  const lines: string[] = [];
  lines.push(`## 貸借対照表 ${report.start_date} 〜 ${report.end_date}`);
  lines.push("");

  if (shown.length === 0) {
    // **黙って空の表を返さない。** 「残高が無い」のか「絞り込みで消えた」のか
    // を区別できるようにする。
    lines.push(
      `該当する科目はありません（全 ${rows.length} 科目。残高が 0 の科目を` +
        `含めるには include_zero を指定してください）。`
    );
    return lines.join("\n");
  }

  lines.push("科目 | 期首残高 | 借方 | 貸方 | 期末残高");
  lines.push("--- | ---: | ---: | ---: | ---:");
  for (const row of shown) {
    lines.push(
      [
        row.account_item_name,
        yen(row.opening_balance),
        yen(row.debit_amount),
        yen(row.credit_amount),
        yen(row.closing_balance),
      ].join(" | ")
    );
  }

  const hiddenCount = rows.length - shown.length;
  if (hiddenCount > 0) {
    lines.push("");
    lines.push(`（残高・増減がいずれも 0 の ${hiddenCount} 科目は省略）`);
  }
  return lines.join("\n");
}
