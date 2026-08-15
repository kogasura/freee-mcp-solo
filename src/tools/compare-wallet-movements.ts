import { FreeeClient } from "../api/freee-client.js";
import { MasterCache } from "../cache/master-cache.js";
import { Walletable, WalletTxn, WalletTxnResponse } from "../api/types.js";

/**
 * 口座の1件ごとの動きを、帳簿と明細で突き合わせる。
 *
 * # `reconcile_wallets` との違い
 *
 * あちらは**残高**を月ごとに比べる。こちらは**1件ごとの動き**を
 * 日付と金額で数え、どちらに何件多いかを出す。残高が合っていても
 * 「2件を1件にまとめた」ような誤りは残高では消えるので、両方が要る。
 *
 * # 実際に見つけた誤り
 *
 * この方法で weBanana.SP の過年度を調べたところ、
 *
 * | 年 | 見つかったもの |
 * |---|---|
 * | 2023 | カード引落し12件の記帳漏れ（426,483円） |
 * | 2024 | カード引落し5件の記帳漏れ（78,055円） |
 * | 2025 | 二重計上23件（1,420,182円） |
 * | 2026 | なし |
 *
 * 各年の累計は、freee の貸借対照表と実残高の差に1円まで一致した。
 *
 * # 件数で比べる（1件ずつ消し込まない）
 *
 * 同じ日に同額の取引が複数あることは普通にある（2025年3月には
 * 300,000円 の振込が3件あった）。1件ずつ消し込む方式だと**取り違える**。
 * 実際、最初その方法で誤った一覧を出した。日付と金額ごとの**件数**で
 * 比べれば取り違えない。
 *
 * # 差が出ても誤りとは限らない
 *
 * 正当に差が出る形がある。
 *
 * - 1つの明細を複数の取引に分けた（ATM出金 260,000 を家賃と生活費に分解）
 * - カードの引落し（銀行の明細には出るが、カード明細には出ない）
 * - 金額0円の記録（同じ駅での入出場）
 *
 * **だから「確かめる価値がある」としか言わない。**
 */

/** 帳簿・明細それぞれの1件の動き。入金が正、出金が負。 */
interface Movement {
  date: string;
  amount: number;
}

/** 突合の結果（口座1つ分）。 */
export interface WalletComparison {
  walletName: string;
  bookCount: number;
  feedCount: number;
  /** 帳簿にだけ多い動き。 */
  onlyInBook: { date: string; amount: number; extra: number }[];
  /** 明細にだけある動き。 */
  onlyInFeed: { date: string; amount: number; extra: number }[];
}

/** 日付＋符号付き金額ごとに数える。 */
function countByDateAndAmount(movements: Movement[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of movements) {
    const key = `${m.date}|${m.amount}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * 2つの動きの集合を突き合わせる。
 *
 * **純関数にしてある。** freee を叩かずに規則だけを検証できるようにするため。
 */
export function compareMovements(
  walletName: string,
  book: Movement[],
  feed: Movement[]
): WalletComparison {
  const bookCounts = countByDateAndAmount(book);
  const feedCounts = countByDateAndAmount(feed);

  const onlyInBook: WalletComparison["onlyInBook"] = [];
  const onlyInFeed: WalletComparison["onlyInFeed"] = [];

  for (const [key, count] of bookCounts) {
    const inFeed = feedCounts.get(key) ?? 0;
    if (count > inFeed) {
      const [date, amount] = key.split("|");
      onlyInBook.push({ date, amount: Number(amount), extra: count - inFeed });
    }
  }
  for (const [key, count] of feedCounts) {
    const inBook = bookCounts.get(key) ?? 0;
    if (count > inBook) {
      const [date, amount] = key.split("|");
      onlyInFeed.push({ date, amount: Number(amount), extra: count - inBook });
    }
  }

  // 金額の大きい順。**先頭しか読まれないことがあるので、並び順が
  // 「何を見せるか」になる**（kaikei の重複検出と同じ理由）。
  const byAbsAmount = (
    a: { amount: number; extra: number },
    b: { amount: number; extra: number }
  ) => Math.abs(b.amount * b.extra) - Math.abs(a.amount * a.extra);
  onlyInBook.sort(byAbsAmount);
  onlyInFeed.sort(byAbsAmount);

  return {
    walletName,
    bookCount: book.length,
    feedCount: feed.length,
    onlyInBook,
    onlyInFeed,
  };
}

/** 差額の合計（余分な件数で重み付け）。 */
export function totalOf(rows: { amount: number; extra: number }[]): number {
  return rows.reduce((sum, r) => sum + r.amount * r.extra, 0);
}

async function fetchFeed(
  client: FreeeClient,
  wallet: Walletable,
  startDate: string,
  endDate: string
): Promise<Movement[]> {
  const out: Movement[] = [];
  let offset = 0;
  for (let page = 0; page < 30; page++) {
    const res = await client.get<WalletTxnResponse>("/api/1/wallet_txns", {
      walletable_type: wallet.type,
      walletable_id: wallet.id,
      start_date: startDate,
      end_date: endDate,
      limit: 100,
      offset,
    });
    const txns: WalletTxn[] = res.wallet_txns ?? [];
    for (const t of txns) {
      out.push({
        date: t.date,
        amount: t.entry_side === "income" ? t.amount : -t.amount,
      });
    }
    if (txns.length < 100) break;
    offset += 100;
  }
  return out;
}

interface Deal {
  type: string;
  payments?: { date: string; amount: number; from_walletable_id?: number }[];
}

interface Transfer {
  date: string;
  amount: number;
  from_walletable_id: number;
  to_walletable_id: number;
}

interface CompareParams {
  start_date: string;
  end_date: string;
  /** 口座名の部分一致で絞る。省略時は全口座。 */
  wallet_name?: string;
}

export async function compareWalletMovements(
  client: FreeeClient,
  cache: MasterCache,
  params: CompareParams
): Promise<string> {
  const walletables = await cache.getWalletables();
  const wallets = params.wallet_name
    ? walletables.filter((w) => w.name.includes(params.wallet_name!))
    : walletables;
  if (wallets.length === 0) {
    return `口座が見つかりません（指定: ${params.wallet_name ?? "（全て）"}）`;
  }

  // 取引と口座振替をまとめて取り、口座ごとに振り分ける。
  const deals: Deal[] = [];
  let offset = 0;
  for (let page = 0; page < 30; page++) {
    const res = await client.get<{ deals?: Deal[] }>("/api/1/deals", {
      start_issue_date: params.start_date,
      end_issue_date: params.end_date,
      limit: 100,
      offset,
    });
    const got = res.deals ?? [];
    deals.push(...got);
    if (got.length < 100) break;
    offset += 100;
  }
  const transfers =
    (
      await client.get<{ transfers?: Transfer[] }>("/api/1/transfers", {
        start_date: params.start_date,
        end_date: params.end_date,
        limit: 100,
      })
    ).transfers ?? [];

  const lines: string[] = [
    `## 口座の動きの突合（${params.start_date} 〜 ${params.end_date}）`,
    "",
  ];
  let anyDifference = false;

  for (const wallet of wallets) {
    const book: Movement[] = [];
    for (const deal of deals) {
      for (const p of deal.payments ?? []) {
        if (p.from_walletable_id !== wallet.id) continue;
        book.push({
          date: p.date,
          amount: deal.type === "income" ? p.amount : -p.amount,
        });
      }
    }
    for (const t of transfers) {
      if (t.from_walletable_id === wallet.id) {
        book.push({ date: t.date, amount: -t.amount });
      }
      if (t.to_walletable_id === wallet.id) {
        book.push({ date: t.date, amount: t.amount });
      }
    }
    const feed = await fetchFeed(client, wallet, params.start_date, params.end_date);
    if (book.length === 0 && feed.length === 0) continue;

    const result = compareMovements(wallet.name, book, feed);
    const bookOnly = totalOf(result.onlyInBook);
    const feedOnly = totalOf(result.onlyInFeed);
    lines.push(
      `### ${wallet.name}（帳簿 ${result.bookCount} 件 / 明細 ${result.feedCount} 件）`
    );
    if (result.onlyInBook.length === 0 && result.onlyInFeed.length === 0) {
      lines.push("差はありません。");
      lines.push("");
      continue;
    }
    anyDifference = true;
    if (result.onlyInBook.length > 0) {
      lines.push(
        `- **帳簿にだけある動き: ${result.onlyInBook.length} 種（合計 ${bookOnly.toLocaleString("ja-JP")} 円）**`
      );
      for (const r of result.onlyInBook.slice(0, 10)) {
        lines.push(`    ${r.date}  ${r.amount.toLocaleString("ja-JP")} 円 ×${r.extra}`);
      }
      if (result.onlyInBook.length > 10) {
        lines.push(`    …ほか ${result.onlyInBook.length - 10} 種`);
      }
    }
    if (result.onlyInFeed.length > 0) {
      lines.push(
        `- **明細にだけある動き: ${result.onlyInFeed.length} 種（合計 ${feedOnly.toLocaleString("ja-JP")} 円）**`
      );
      for (const r of result.onlyInFeed.slice(0, 10)) {
        lines.push(`    ${r.date}  ${r.amount.toLocaleString("ja-JP")} 円 ×${r.extra}`);
      }
      if (result.onlyInFeed.length > 10) {
        lines.push(`    …ほか ${result.onlyInFeed.length - 10} 種`);
      }
    }
    lines.push("");
  }

  if (!anyDifference) {
    lines.push("**どの口座にも差はありませんでした。**");
    return lines.join("\n");
  }

  lines.push("---");
  lines.push(
    "※ 差が出ても誤りとは限りません。正当に差が出る形があります。"
  );
  lines.push(
    "  ・1つの明細を複数の取引に分けた（ATM出金を家賃と生活費に分解するなど）"
  );
  lines.push("  ・カードの引落し（銀行の明細には出るが、カード明細には出ない）");
  lines.push("  ・金額0円の記録（同じ駅での入出場など）");
  lines.push(
    "  1件ずつ中身を見て判断してください。「帳簿にだけある」は二重計上、"
  );
  lines.push("  「明細にだけある」は記帳漏れの疑いです。");
  return lines.join("\n");
}
