import { FreeeClient } from "../api/freee-client.js";
import { MasterCache } from "../cache/master-cache.js";
import { Walletable, WalletTxn, WalletTxnResponse } from "../api/types.js";

/**
 * 帳簿上の口座残高と、口座の実際の明細を突き合わせる。
 *
 * # 「損益は合うのに残高だけ合わない」を見つける
 *
 * 月次の収支サマリーが一致していても、口座の残高は合わないことがある。
 * 同じ出金を二重に計上していても、片方が事業主貸なら**損益は変わらない**
 * ためである。残高で見て初めて分かる。
 *
 * 実際に weBanana.SP で、ATM出金の内訳（家賃・生活費）と出金そのものを
 * 両方計上していた誤りが 310,000 円分あり、これは損益サマリーでは
 * 見つからなかった。
 *
 * # 月ごとに見る
 *
 * 合計だけを比べても、どこで狂ったかが分からない。月ごとに動きを比べると、
 * **食い違う月が特定できる**——実際、上の誤りは7月だけがずれていて、
 * 他の月は1円も違わなかったので、探す範囲がすぐ絞れた。
 *
 * # 期首は別に見る
 *
 * 期首がずれていると、その後の月がすべて一致していても残高は合わない。
 * これは**その年の記帳の問題ではない**（前年以前の開始残高の問題）ので、
 * 月々の食い違いと混ぜない。
 *
 * # クレジットカードは対象にしない
 *
 * カードの支払いを**未払金**で管理していると、カード口座の帳簿残高と明細は
 * 正当にずれる（購入はカード口座に立つが、支払いは未払金と銀行の間で動くので
 * カード口座が減らない）。これは記帳方法の違いであって誤りではない。
 *
 * **正しい帳簿を食い違いとして報告すると、本当の食い違いが埋もれる。**
 * 実際に weBanana.SP で試したところ、カードだけで12件の「食い違い」が出て、
 * そのすべてが記帳方法によるものだった。だから銀行・現金・電子マネーに限る。
 *
 * カードの残高を確かめたい場合は、未払金の残高とカードの利用明細を突き合わせる
 * ことになるが、それはこの道具の範囲外である。
 */
interface ReconcileParams {
  /** 対象の年（西暦）。 */
  year: number;
  /** 口座名で絞り込む（部分一致）。 */
  wallet_name?: string;
}

interface TrialBsBalance {
  account_item_name?: string;
  opening_balance?: number;
  closing_balance?: number;
}

interface TrialBsResponse {
  trial_bs?: { balances?: TrialBsBalance[] };
}

/** 月の初日と末日。 */
function monthRange(year: number, month: number): [string, string] {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, "0");
  return [`${year}-${mm}-01`, `${year}-${mm}-${String(last).padStart(2, "0")}`];
}

/** 口座の明細をその年ぶん取る。 */
async function fetchTxns(
  client: FreeeClient,
  wallet: Walletable,
  year: number
): Promise<WalletTxn[]> {
  const all: WalletTxn[] = [];
  let offset = 0;
  const pageSize = 100;
  for (let page = 0; page < 30; page++) {
    const res = await client.get<WalletTxnResponse>("/api/1/wallet_txns", {
      walletable_type: wallet.type,
      walletable_id: wallet.id,
      start_date: `${year}-01-01`,
      end_date: `${year}-12-31`,
      limit: pageSize,
      offset,
    });
    const txns = res.wallet_txns ?? [];
    all.push(...txns);
    if (txns.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

/** 明細の符号付き金額。入金が正。 */
function signed(txn: WalletTxn): number {
  return txn.entry_side === "income" ? txn.amount : -txn.amount;
}

export async function reconcileWallets(
  client: FreeeClient,
  cache: MasterCache,
  params: ReconcileParams
): Promise<string> {
  const walletables = await cache.getWalletables();
  // **クレジットカードは外す。** 支払いを未払金で管理していると正当にずれる
  // （型 doc の「クレジットカードは対象にしない」）。
  const comparable = walletables.filter((w) => w.type !== "credit_card");
  const excluded = walletables.filter((w) => w.type === "credit_card");
  const wallets = params.wallet_name
    ? comparable.filter((w) => w.name.includes(params.wallet_name!))
    : comparable;
  if (wallets.length === 0) {
    return `突き合わせできる口座がありません（指定: ${
      params.wallet_name ?? "（全て）"
    }）。クレジットカードは対象外です。`;
  }

  // 帳簿側の月次の動きを取る。**12回で済ませる**（口座ごとに引くと
  // 口座数 × 12 回になる）。
  const bookByMonth: Map<string, Map<number, number>> = new Map();
  const bookOpening: Map<string, number> = new Map();
  for (let month = 1; month <= 12; month++) {
    const [from, to] = monthRange(params.year, month);
    const res = await client.get<TrialBsResponse>("/api/1/reports/trial_bs", {
      start_date: from,
      end_date: to,
    });
    for (const row of res.trial_bs?.balances ?? []) {
      const name = row.account_item_name;
      if (!name) continue;
      const opening = row.opening_balance ?? 0;
      const closing = row.closing_balance ?? 0;
      if (!bookByMonth.has(name)) bookByMonth.set(name, new Map());
      bookByMonth.get(name)!.set(month, closing - opening);
      if (month === 1 && !bookOpening.has(name)) bookOpening.set(name, opening);
    }
  }

  const lines: string[] = [`## 口座残高の突き合わせ（${params.year}年）`, ""];
  let anyGap = false;

  for (const wallet of wallets) {
    const txns = await fetchTxns(client, wallet, params.year);
    if (txns.length === 0) continue;

    const actualByMonth = new Map<number, number>();
    for (const txn of txns) {
      const month = Number(txn.date.slice(5, 7));
      actualByMonth.set(month, (actualByMonth.get(month) ?? 0) + signed(txn));
    }

    // 明細が持つ残高から、期首（最初の明細の直前）を割り出す。
    const sorted = [...txns].sort((a, b) => a.date.localeCompare(b.date));
    const first = sorted[0];
    const actualOpening =
      first.balance !== undefined ? first.balance - signed(first) : undefined;

    const book = bookByMonth.get(wallet.name);
    if (!book) {
      lines.push(
        `### ${wallet.name}\n- 帳簿にこの口座の科目が見つかりません（科目名が口座名と違う可能性）`
      );
      lines.push("");
      continue;
    }

    const monthLines: string[] = [];
    for (let month = 1; month <= 12; month++) {
      const actual = actualByMonth.get(month);
      const recorded = book.get(month) ?? 0;
      if (actual === undefined && recorded === 0) continue;
      const gap = recorded - (actual ?? 0);
      if (gap !== 0) {
        anyGap = true;
        monthLines.push(
          `  - ${params.year}-${String(month).padStart(2, "0")}: ` +
            `帳簿 ${yen(recorded)} / 実際 ${yen(actual ?? 0)} → ` +
            `**差 ${yen(gap)}**`
        );
      }
    }

    lines.push(`### ${wallet.name}`);
    const opening = bookOpening.get(wallet.name);
    if (actualOpening !== undefined && opening !== undefined && opening !== actualOpening) {
      anyGap = true;
      // **期首の食い違いは月々のものと混ぜない。** その年の記帳ではなく、
      // 前年以前の開始残高の問題である。
      lines.push(
        `- 期首: 帳簿 ${yen(opening)} / 実際 ${yen(actualOpening)} → ` +
          `**差 ${yen(opening - actualOpening)}**` +
          `（${params.year}年の記帳ではなく、前年以前の開始残高の問題です）`
      );
    }
    if (monthLines.length === 0) {
      lines.push(`- 月々の動きは全て一致しました（明細 ${txns.length} 件）`);
    } else {
      lines.push(`- 食い違う月:`);
      lines.push(...monthLines);
    }
    lines.push("");
  }

  if (excluded.length > 0) {
    // **外したことを黙らない。** 全部見たと読まれると、カードの誤りが
    // 見つかったと誤解される。
    lines.push(
      `※ クレジットカード（${excluded
        .map((w) => w.name)
        .join("・")}）は突き合わせていません。` +
        `支払いを未払金で管理していると、カード口座の帳簿残高と明細は正当に` +
        `ずれるためです（記帳方法の違いであって誤りではありません）。`
    );
    lines.push("");
  }

  if (!anyGap) {
    lines.push("食い違いはありません。");
  } else {
    lines.push(
      "※ 差が出た月は、同じ取引を二重に計上している／明細にない取引を" +
        "計上している／明細にある取引を計上していない、のいずれかです。" +
        "同じ出金を二重に計上していても片方が事業主貸なら損益は変わらないので、" +
        "**収支サマリーの突き合わせでは見つかりません。**"
    );
  }
  return lines.join("\n");
}

/** 金額を表示用にする。 */
function yen(amount: number): string {
  return `¥${amount.toLocaleString("ja-JP")}`;
}
