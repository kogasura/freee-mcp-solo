import { FreeeClient } from "../api/freee-client.js";
import { MasterCache } from "../cache/master-cache.js";
import type { Walletable, WalletTxn, WalletTxnResponse } from "../api/types.js";
import { formatYen } from "../utils/date-helpers.js";
import { findProcessedTwin, pickWalletTxn } from "./create-deal.js";

interface RecordTransferParams {
  date: string;
  amount: number;
  from: string;
  to: string;
  description?: string;
}

interface Transfer {
  id: number;
  date: string;
  amount: number;
  from_walletable_type: string;
  from_walletable_id: number;
  to_walletable_type: string;
  to_walletable_id: number;
}

/**
 * 口座間の移動（カード引落し・Suica チャージ・口座間の振込）を登録する。
 *
 * # なぜ要るのか
 *
 * **カード引落しを「支出／未払金」や「事業主貸」の取引で入れると、カードの残高が
 * 減らず、負債が二重になる。** 経費はカードの明細の側で計上済みだからである。
 * 2026年3〜8月に引落し9件がこの形で入っており、未払金がマイナスになっていた。
 * 口座振替で入れれば起きない。
 *
 * 明細があれば明細から登録して紐付ける（create_deal と同じ理由。紐付けないと
 * 明細が「未処理」のまま残り、「自動で経理」で二重に登録されうる）。
 * 出金側（引落し元）の明細を先に探し、無ければ入金側（チャージ先など）を探す。
 *
 * # 二重に登録しない
 *
 * freee は1つの明細から振替を作るので、両側に明細がある口座どうしでは、
 * 反対側の明細が未処理のまま残る。**呼び直すとその明細から2本目の振替ができる。**
 * そこで、どちらかの側に処理済みの同じ明細があるとき、または同じ日・同じ金額・
 * 同じ向きの振替がすでにあるときは、登録せずに止める。
 *
 * メモタグは付けない。口座振替の行のタグは「口座タグ設定」が未設定だと指定
 * できない（POST /api/1/transfers のスキーマ）とされ、create_transfer でも
 * 同じかは実測していない。付けて 400 になると本筋の登録ができなくなる。
 */
export function buildTransferFromWalletTxnBody(params: {
  from: Pick<Walletable, "type" | "id">;
  to: Pick<Walletable, "type" | "id">;
  amount: number;
  description?: string;
}): Record<string, unknown> {
  // 摘要は振替先の行に入れる。入れないと null になる（実測）
  const toLine: Record<string, unknown> = {
    walletable_type: params.to.type,
    walletable_id: params.to.id,
    amount: params.amount,
  };
  if (params.description) toLine.description = params.description;

  return {
    transfer_from_line: {
      walletable_type: params.from.type,
      walletable_id: params.from.id,
    },
    transfer_to_lines: [toLine],
  };
}

/** 同じ日・同じ金額・同じ向きの振替がすでにあるか */
export function findSameTransfer(
  transfers: Transfer[],
  target: {
    date: string;
    amount: number;
    from: Pick<Walletable, "type" | "id">;
    to: Pick<Walletable, "type" | "id">;
  }
): Transfer | undefined {
  return transfers.find(
    (t) =>
      t.date === target.date &&
      t.amount === target.amount &&
      t.from_walletable_type === target.from.type &&
      t.from_walletable_id === target.from.id &&
      t.to_walletable_type === target.to.type &&
      t.to_walletable_id === target.to.id
  );
}

async function fetchTxns(
  client: FreeeClient,
  wallet: Walletable,
  date: string,
  side: "income" | "expense"
): Promise<WalletTxn[]> {
  const res = await client.get<WalletTxnResponse>("/api/1/wallet_txns", {
    walletable_type: wallet.type,
    walletable_id: wallet.id,
    start_date: date,
    end_date: date,
    entry_side: side,
    limit: 100,
  });
  return res.wallet_txns ?? [];
}

export async function recordTransfer(
  client: FreeeClient,
  cache: MasterCache,
  params: RecordTransferParams
): Promise<string> {
  const from = await cache.resolveWalletable(params.from);
  const to = await cache.resolveWalletable(params.to);
  if (!from || !to) {
    const names = (await cache.getWalletables()).map((w) => w.name).join(", ");
    const missing = [!from && params.from, !to && params.to].filter(Boolean).join("・");
    return `エラー: 口座「${missing}」が見つかりません。\n登録済み口座: ${names}`;
  }
  if (from.id === to.id && from.type === to.type) {
    return "エラー: 移動元と移動先が同じ口座です。";
  }

  const head = `${params.date} ${from.name} → ${to.name} ${formatYen(params.amount)}`;
  const outTarget = { date: params.date, amount: params.amount, type: "expense" as const };
  const inTarget = { date: params.date, amount: params.amount, type: "income" as const };

  const outTxns = await fetchTxns(client, from, params.date, "expense");
  const inTxns = await fetchTxns(client, to, params.date, "income");

  // 1. どちらかの側の同じ明細がもう処理済みなら止める（呼び直しによる二重振替）
  const twin = findProcessedTwin(outTxns, outTarget) ?? findProcessedTwin(inTxns, inTarget);
  if (twin) {
    return [
      `登録を止めました: ${head} の明細（ID: ${twin.id}）は、すでに処理済み（status ${twin.status}）です。`,
      `  この移動はもう登録されている可能性が高いので、登録すると二重になります。list_transfers で確かめてください。`,
      `  反対側の明細が未処理で残っている場合は、freee の画面でその振替と消し込んでください（record_transfer で登録し直さない）。`,
    ].join("\n");
  }

  // 2. 明細の取り込み前に登録した同じ振替があれば止める
  const existing = await client.get<{ transfers: Transfer[] }>("/api/1/transfers", {
    start_date: params.date,
    end_date: params.date,
    limit: 100,
  });
  const same = findSameTransfer(existing.transfers ?? [], {
    date: params.date,
    amount: params.amount,
    from,
    to,
  });
  if (same) {
    return [
      `登録を止めました: ${head} の口座振替（ID: ${same.id}）がすでにあります。`,
      `  明細が後から届いた場合は、freee の画面でその振替と消し込んでください（record_transfer で登録し直さない）。`,
    ].join("\n");
  }

  const txn = pickWalletTxn(outTxns, outTarget) ?? pickWalletTxn(inTxns, inTarget);

  if (txn) {
    const body = buildTransferFromWalletTxnBody({
      from,
      to,
      amount: params.amount,
      description: params.description,
    });
    const res = await client.post<{ transfer_ids: number[] }>(
      `/api/1/wallet_txns/${txn.id}/create_transfer`,
      body
    );
    const lines = [
      `登録完了 口座振替 (ID: ${res.transfer_ids?.join(", ")})`,
      `  ${head}${params.description ? ` / ${params.description}` : ""}`,
      `  明細 ${txn.id}（${txn.walletable_id === from.id ? from.name : to.name}）と紐付け済み`,
    ];
    // 反対側にも未処理の明細があれば、そちらは紐付いていない（freee は1明細から作る）
    const other =
      txn.walletable_id === from.id
        ? pickWalletTxn(inTxns, inTarget)
        : pickWalletTxn(outTxns, outTarget);
    if (other) {
      lines.push(
        `  ※ ${other.walletable_id === from.id ? from.name : to.name} 側にも同じ明細（ID: ${other.id}）があり、未処理のまま残っています。` +
          `freee の画面でこの振替と消し込んでください（record_transfer で登録し直さない）。`
      );
    }
    return lines.join("\n");
  }

  // 3. 明細がまだ無い（取り込み前・同期が止まっている）
  const res = await client.post<{ transfer: { id: number } }>("/api/1/transfers", {
    date: params.date,
    amount: params.amount,
    from_walletable_type: from.type,
    from_walletable_id: from.id,
    to_walletable_type: to.type,
    to_walletable_id: to.id,
    description: params.description,
  });
  return [
    `登録完了 口座振替 (ID: ${res.transfer.id})`,
    `  ${head}${params.description ? ` / ${params.description}` : ""}`,
    `  ※ どちらの口座にも未処理の明細が無かったため、明細と紐付いていません。明細が取り込まれたら、freee の画面で消し込んでください（record_transfer で登録し直さない）。`,
  ].join("\n");
}
