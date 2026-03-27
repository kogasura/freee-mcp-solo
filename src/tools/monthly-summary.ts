import { FreeeClient } from "../api/freee-client.js";
import { MasterCache } from "../cache/master-cache.js";
import type { Deal, DealsResponse } from "../api/types.js";
import { monthStart, monthEnd, formatYen } from "../utils/date-helpers.js";

interface MonthlySummaryParams {
  year?: number;
  month?: number;
}

interface CategoryTotal {
  name: string;
  amount: number;
  count: number;
}

export async function monthlySummary(
  client: FreeeClient,
  cache: MasterCache,
  params: MonthlySummaryParams
): Promise<string> {
  const now = new Date();
  const year = params.year ?? now.getFullYear();
  const month = params.month ?? now.getMonth() + 1;
  const start = monthStart(year, month);
  const end = monthEnd(year, month);

  // 収入・支出を並列取得
  const [incomeDeals, expenseDeals] = await Promise.all([
    fetchAllDeals(client, "income", start, end),
    fetchAllDeals(client, "expense", start, end),
  ]);

  // 勘定科目マスタを取得（ID→名前変換用）
  const accountItems = await cache.getAccountItems();
  const accountMap = new Map(accountItems.map((a) => [a.id, a.name]));

  // 科目別集計
  const incomeByCategory = aggregateByCategory(incomeDeals, accountMap);
  const expenseByCategory = aggregateByCategory(expenseDeals, accountMap);

  const incomeTotal = incomeDeals.reduce((s, d) => s + d.amount, 0);
  const expenseTotal = expenseDeals.reduce((s, d) => s + d.amount, 0);
  const profit = incomeTotal - expenseTotal;

  // 整形
  const lines: string[] = [];
  lines.push(`## ${year}年${month}月 収支サマリー`);
  lines.push("");

  lines.push(`収入: ${formatYen(incomeTotal)}`);
  for (const cat of incomeByCategory) {
    lines.push(`  ${cat.name}: ${formatYen(cat.amount)} (${cat.count}件)`);
  }
  lines.push("");

  lines.push(`支出: ${formatYen(expenseTotal)}`);
  for (const cat of expenseByCategory) {
    lines.push(`  ${cat.name}: ${formatYen(cat.amount)} (${cat.count}件)`);
  }
  lines.push("");

  lines.push(`差引利益: ${formatYen(profit)}`);

  return lines.join("\n");
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

function aggregateByCategory(
  deals: Deal[],
  accountMap: Map<number, string>
): CategoryTotal[] {
  const map = new Map<string, { amount: number; count: number }>();

  for (const deal of deals) {
    for (const detail of deal.details) {
      const name = accountMap.get(detail.account_item_id) ?? "不明";
      const entry = map.get(name) ?? { amount: 0, count: 0 };
      entry.amount += detail.amount;
      entry.count += 1;
      map.set(name, entry);
    }
  }

  return Array.from(map.entries())
    .map(([name, { amount, count }]) => ({ name, amount, count }))
    .sort((a, b) => b.amount - a.amount); // 金額降順
}
