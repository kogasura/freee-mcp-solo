import { FreeeClient } from "../api/freee-client.js";
import { MasterCache } from "../cache/master-cache.js";
import type { WalletTxn, WalletTxnResponse, Walletable } from "../api/types.js";
import { today, daysAgo, formatYen } from "../utils/date-helpers.js";

interface PendingTransactionsParams {
  wallet_name?: string;
  start_date?: string;
  end_date?: string;
  limit?: number;
}

interface PendingGroup {
  wallet: Walletable;
  txns: WalletTxn[];
}

export async function pendingTransactions(
  client: FreeeClient,
  cache: MasterCache,
  params: PendingTransactionsParams
): Promise<string> {
  const startDate = params.start_date ?? daysAgo(30);
  const endDate = params.end_date ?? today();
  const limit = Math.min(params.limit ?? 50, 100);

  let walletables: Walletable[];

  if (params.wallet_name) {
    const resolved = await cache.resolveWalletable(params.wallet_name);
    if (!resolved) {
      const all = await cache.getWalletables();
      const names = all.map((w) => w.name).join(", ");
      return `口座「${params.wallet_name}」が見つかりません。\n登録済み口座: ${names}`;
    }
    walletables = [resolved];
  } else {
    walletables = await cache.getWalletables();
  }

  const groups: PendingGroup[] = [];
  let totalCount = 0;

  for (const wallet of walletables) {
    const txns = await fetchPendingTxns(
      client,
      wallet,
      startDate,
      endDate,
      limit - totalCount
    );
    if (txns.length > 0) {
      groups.push({ wallet, txns });
      totalCount += txns.length;
    }
    if (totalCount >= limit) break;
  }

  if (totalCount === 0) {
    return `未処理明細はありません（${startDate} 〜 ${endDate}）`;
  }

  return formatPendingGroups(groups, totalCount, startDate, endDate);
}

async function fetchPendingTxns(
  client: FreeeClient,
  wallet: Walletable,
  startDate: string,
  endDate: string,
  maxCount: number
): Promise<WalletTxn[]> {
  const pending: WalletTxn[] = [];
  let offset = 0;
  const pageSize = 100;
  const maxPages = 20; // 最大2000件で打ち切り

  for (let page = 0; page < maxPages && pending.length < maxCount; page++) {
    const res = await client.get<WalletTxnResponse>("/api/1/wallet_txns", {
      walletable_type: wallet.type,
      walletable_id: wallet.id,
      start_date: startDate,
      end_date: endDate,
      limit: pageSize,
      offset,
    });

    const txns = res.wallet_txns ?? [];
    const filtered = txns.filter((t) => t.due_amount > 0);
    pending.push(...filtered);

    // 取得件数がpageSize未満なら最終ページ
    if (txns.length < pageSize) break;
    offset += pageSize;
  }

  return pending.slice(0, maxCount);
}

function formatPendingGroups(
  groups: PendingGroup[],
  totalCount: number,
  startDate: string,
  endDate: string
): string {
  const lines: string[] = [];
  lines.push(`## 未処理明細: ${totalCount}件（${startDate} 〜 ${endDate}）`);
  lines.push("");

  let seq = 1;
  for (const group of groups) {
    lines.push(`### ${group.wallet.name}（${group.txns.length}件）`);
    for (const txn of group.txns) {
      const side = txn.entry_side === "income" ? "入金" : "出金";
      const date = txn.date.slice(5); // mm-dd
      lines.push(
        `#${seq} (id:${txn.id}) ${date} ${side} ${formatYen(txn.amount)}  ${txn.description}`
      );
      seq++;
    }
    lines.push("");
  }

  return lines.join("\n");
}
