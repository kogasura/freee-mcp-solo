import { FreeeClient } from "../api/freee-client.js";
import { MasterCache } from "../cache/master-cache.js";
import {
  Deal,
  Walletable,
  WalletTxn,
  WalletTxnResponse,
} from "../api/types.js";

/**
 * 口座明細のうち、**対応する取引が見当たらないもの**を挙げる。
 *
 * # 「未処理明細」をそのまま信じない
 *
 * freee の未処理明細（`due_amount > 0`）は「明細が取引に紐付いていない」
 * という意味であって、「記帳されていない」ではない。手で登録した取引は
 * 明細と紐付かないので、**記帳済みでも未処理明細に残り続ける**。実際に
 * 100件超が残っていて、その大半は記帳済みだった。
 *
 * だから未処理明細だけを見ても、記帳漏れは見つからない。取引の側と
 * 突き合わせて初めて分かる。
 *
 * # なぜ要るのか
 *
 * 記帳漏れは**決算のときに気づいても遅い**。経費なら所得が過大になり、
 * 売上なら過少申告になる。月次で見つけられれば、記憶が新しいうちに
 * 科目を決められる。
 *
 * # これは「疑い」であって「漏れ」ではない
 *
 * 突き合わせは日付と金額で行う。次の場合は取りこぼす／余計に挙がる:
 *
 * - 1つの明細を複数の取引に分けた（金額が一致しない）
 * - 複数の明細をまとめて1つの取引にした
 * - カードの購入日と引落日が違う日付で記帳した
 *
 * **だから断定しない。** 挙げるのは「確かめる価値がある明細」までである。
 */
interface UnrecordedParams {
  /** 発生日の開始 yyyy-mm-dd。 */
  start_date: string;
  /** 発生日の終了 yyyy-mm-dd。 */
  end_date: string;
  /** 口座名で絞り込む（部分一致）。 */
  wallet_name?: string;
}

interface DealsResponse {
  deals: Deal[];
}

/** 突き合わせに使う鍵。日付と金額と向き。 */
function key(date: string, amount: number, side: "income" | "expense"): string {
  return `${date}${amount}${side}`;
}

/**
 * 期間内の取引を、日付・金額・向きの**多重集合**にする。
 *
 * 集合ではなく多重集合にするのは、同じ日に同じ額の取引が2件あるとき、
 * 明細も2件あって初めて釣り合うからである。集合にすると、2件目の明細が
 * 「記帳済み」と誤判定される。
 */
async function fetchDealKeys(
  client: FreeeClient,
  startDate: string,
  endDate: string
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const type of ["income", "expense"] as const) {
    let offset = 0;
    const pageSize = 100;
    for (let page = 0; page < 20; page++) {
      const res = await client.get<DealsResponse>("/api/1/deals", {
        type,
        start_issue_date: startDate,
        end_issue_date: endDate,
        limit: pageSize,
        offset,
      });
      const deals = res.deals ?? [];
      for (const deal of deals) {
        const k = key(deal.issue_date, deal.amount, type);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      if (deals.length < pageSize) break;
      offset += pageSize;
    }
  }
  return counts;
}

/** 未処理の明細（`due_amount > 0`）を口座ごとに取る。 */
async function fetchPendingTxns(
  client: FreeeClient,
  wallet: Walletable,
  startDate: string,
  endDate: string
): Promise<WalletTxn[]> {
  const pending: WalletTxn[] = [];
  let offset = 0;
  const pageSize = 100;
  for (let page = 0; page < 20; page++) {
    const res = await client.get<WalletTxnResponse>("/api/1/wallet_txns", {
      walletable_type: wallet.type,
      walletable_id: wallet.id,
      start_date: startDate,
      end_date: endDate,
      limit: pageSize,
      offset,
    });
    const txns = res.wallet_txns ?? [];
    pending.push(...txns.filter((t) => t.due_amount > 0));
    if (txns.length < pageSize) break;
    offset += pageSize;
  }
  return pending;
}

export async function unrecordedTransactions(
  client: FreeeClient,
  cache: MasterCache,
  params: UnrecordedParams
): Promise<string> {
  const walletables = await cache.getWalletables();
  const wallets = params.wallet_name
    ? walletables.filter((w) => w.name.includes(params.wallet_name!))
    : walletables;

  if (wallets.length === 0) {
    return `口座が見つかりません（指定: ${params.wallet_name ?? "（全て）"}）`;
  }

  const dealKeys = await fetchDealKeys(client, params.start_date, params.end_date);

  const suspects: { wallet: Walletable; txn: WalletTxn }[] = [];
  let pendingTotal = 0;
  for (const wallet of wallets) {
    const pending = await fetchPendingTxns(
      client,
      wallet,
      params.start_date,
      params.end_date
    );
    pendingTotal += pending.length;
    for (const txn of pending) {
      const k = key(txn.date, txn.amount, txn.entry_side);
      const remaining = dealKeys.get(k) ?? 0;
      if (remaining > 0) {
        // 1件の取引は1件の明細としか釣り合わない。使ったら減らす。
        dealKeys.set(k, remaining - 1);
      } else {
        suspects.push({ wallet, txn });
      }
    }
  }

  const period = `${params.start_date} 〜 ${params.end_date}`;
  if (suspects.length === 0) {
    return (
      `## 記帳漏れの疑い: 0件（${period}）\n\n` +
      `未処理明細 ${pendingTotal} 件を取引と突き合わせましたが、` +
      `対応する取引が見当たらないものはありませんでした。\n` +
      `※ 未処理明細が残っているのは、手で登録した取引が明細と紐付いて` +
      `いないためで、記帳されていないという意味ではありません。`
    );
  }

  const lines: string[] = [
    `## 記帳漏れの疑い: ${suspects.length}件（${period}）`,
    "",
    `未処理明細 ${pendingTotal} 件のうち、日付と金額が一致する取引が` +
      `見当たらないものです。`,
    "",
  ];

  let total = 0;
  for (const { wallet, txn } of suspects) {
    total += txn.amount;
    const side = txn.entry_side === "income" ? "入金" : "出金";
    lines.push(
      `- ${txn.date} ${side} ¥${txn.amount.toLocaleString("ja-JP")}  ` +
        `${txn.description || "（摘要なし）"}  [${wallet.name}]`
    );
  }
  lines.push("");
  lines.push(`合計: ¥${total.toLocaleString("ja-JP")}`);
  lines.push("");
  // **断定しない。** 突き合わせは日付と金額だけなので、正当に一致しない
  // 形がある。
  lines.push(
    `※ これは「確かめる価値がある明細」であって、記帳漏れと決まった` +
      `わけではありません。1つの明細を複数の取引に分けた場合、複数の明細を` +
      `まとめて1つの取引にした場合、カードの購入日と引落日を違う日付で` +
      `記帳した場合は、漏れていなくてもここに挙がります。`
  );
  return lines.join("\n");
}
