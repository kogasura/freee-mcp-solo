import { FreeeClient } from "../api/freee-client.js";
import { MasterCache } from "../cache/master-cache.js";
import type { Deal, DealsResponse } from "../api/types.js";
import { today, daysAgo, formatYen } from "../utils/date-helpers.js";

interface ListDealsParams {
  start_date?: string;
  end_date?: string;
  account_item?: string;
  type?: "income" | "expense";
  limit?: number;
}

interface DealRow {
  dealId: number;
  date: string;
  type: "income" | "expense";
  accountName: string;
  amount: number;
  description: string;
  partnerName: string;
  walletName: string;
  /** freee の税区分コード。他ソフトへ仕訳を移すときに要る（税区分は
   *  金額と違って画面から読み取れないため、API から拾うしかない）。 */
  taxCode: number;
}

export async function listDeals(
  client: FreeeClient,
  cache: MasterCache,
  params: ListDealsParams
): Promise<string> {
  const startDate = params.start_date ?? daysAgo(30);
  const endDate = params.end_date ?? today();
  const limit = Math.min(params.limit ?? 100, 500);

  // 科目絞込が指定されていれば先に解決（候補が複数なら中断）
  let filterAccountId: number | null = null;
  let filterAccountName = "";
  if (params.account_item) {
    const resolved = await cache.resolveAccountItem(params.account_item);
    if ("candidates" in resolved) {
      return `勘定科目「${params.account_item}」を特定できません。\n候補: ${resolved.candidates.join(", ")}`;
    }
    filterAccountId = resolved.item.id;
    filterAccountName = resolved.item.name;
  }

  const types: Array<"income" | "expense"> = params.type
    ? [params.type]
    : ["income", "expense"];

  const [dealLists, accountItems, partners, walletables] = await Promise.all([
    Promise.all(types.map((t) => fetchAllDeals(client, t, startDate, endDate))),
    cache.getAccountItems(),
    cache.getPartners(),
    cache.getWalletables(),
  ]);

  const accountMap = new Map(accountItems.map((a) => [a.id, a.name]));
  const partnerMap = new Map(partners.map((p) => [p.id, p.name]));
  const walletMap = new Map(
    walletables.map((w) => [`${w.type}:${w.id}`, w.name])
  );

  const rows: DealRow[] = [];
  for (const deal of dealLists.flat()) {
    const payment = deal.payments?.[0];
    const walletName = payment
      ? walletMap.get(
          `${payment.from_walletable_type}:${payment.from_walletable_id}`
        ) ?? "不明な口座"
      : "プライベート資金";

    for (const detail of deal.details) {
      // 科目絞込。指定時は該当する明細行のみ拾う
      if (filterAccountId !== null && detail.account_item_id !== filterAccountId) {
        continue;
      }
      rows.push({
        dealId: deal.id,
        date: deal.issue_date,
        type: deal.type,
        accountName: accountMap.get(detail.account_item_id) ?? "不明",
        amount: detail.amount,
        description: detail.description ?? "",
        partnerName: deal.partner_id
          ? partnerMap.get(deal.partner_id) ?? ""
          : "",
        walletName,
        taxCode: detail.tax_code,
      });
    }
  }

  if (rows.length === 0) {
    const scope = filterAccountName ? `／科目: ${filterAccountName}` : "";
    return `該当する取引はありません（${startDate} 〜 ${endDate}${scope}）`;
  }

  rows.sort((a, b) => a.date.localeCompare(b.date));
  const shown = rows.slice(0, limit);

  return formatRows(shown, rows.length, startDate, endDate, filterAccountName);
}

async function fetchAllDeals(
  client: FreeeClient,
  type: "income" | "expense",
  startDate: string,
  endDate: string
): Promise<Deal[]> {
  const all: Deal[] = [];
  let offset = 0;
  const pageSize = 100;
  const maxPages = 50; // 最大5000件で打ち切り

  for (let page = 0; page < maxPages; page++) {
    const res = await client.get<DealsResponse>("/api/1/deals", {
      type,
      start_issue_date: startDate,
      end_issue_date: endDate,
      limit: pageSize,
      offset,
    });

    const deals = res.deals ?? [];
    all.push(...deals);
    if (deals.length < pageSize) break;
    offset += pageSize;
  }

  return all;
}

function formatRows(
  rows: DealRow[],
  totalCount: number,
  startDate: string,
  endDate: string,
  filterAccountName: string
): string {
  const lines: string[] = [];
  const scope = filterAccountName ? `／科目: ${filterAccountName}` : "";
  const truncated =
    totalCount > rows.length ? `（${rows.length}件を表示）` : "";
  lines.push(
    `## 取引一覧: ${totalCount}件${truncated}（${startDate} 〜 ${endDate}${scope}）`
  );
  lines.push("");

  let seq = 1;
  for (const row of rows) {
    const side = row.type === "income" ? "収入" : "支出";
    const date = row.date.slice(5); // mm-dd
    const parts = [
      `#${seq} (id:${row.dealId})`,
      date,
      side,
      formatYen(row.amount),
      row.accountName,
    ];
    let line = parts.join(" ");
    if (row.description) line += ` / ${row.description}`;
    if (row.partnerName) line += ` / ${row.partnerName}`;
    line += ` [${row.walletName}]`;
    // 税区分コードは末尾に付ける。既存の読み手（人間）は行頭から読むので、
    // 後ろに足すぶんには従来の見え方を変えない。
    line += ` <tax:${row.taxCode}>`;
    lines.push(line);
    seq++;
  }

  lines.push("");
  const total = rows.reduce((s, r) => s + r.amount, 0);
  lines.push(`表示分合計: ${formatYen(total)}`);

  return lines.join("\n");
}
