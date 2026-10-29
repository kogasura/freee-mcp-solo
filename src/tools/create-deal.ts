import { FreeeClient } from "../api/freee-client.js";
import { MasterCache } from "../cache/master-cache.js";
import type {
  DealResponse,
  WalletTxn,
  WalletTxnCreateDealResponse,
  WalletTxnResponse,
} from "../api/types.js";
import { formatYen } from "../utils/date-helpers.js";

interface CreateDealParams {
  type: "income" | "expense";
  issue_date: string;
  amount: number;
  account_item: string;
  wallet_name?: string;
  partner_name?: string;
  description?: string;
}

/** 明細の状態。1 が未処理（どの取引にも紐付いていない） */
const WALLET_TXN_UNPROCESSED = 1;

/**
 * 登録しようとしている取引に当たる未処理の明細を選ぶ。
 *
 * **口座明細がある取引は、明細から登録しないと明細が「未処理」のまま残る。**
 * 2026-10 に未処理が199件たまり、「自動で経理」の画面で登録を押すと
 * 二重計上になる状態だった。日付・金額・入出金の向きが一致する未処理の
 * 明細を探し、あればそこから登録する。
 *
 * 同じ日・同じ金額の未処理明細が複数あっても、どれに当てても帳簿は同じなので
 * 先頭を使う。
 */
export function pickWalletTxn(
  txns: WalletTxn[],
  target: { date: string; amount: number; type: "income" | "expense" }
): WalletTxn | undefined {
  return txns.find(
    (t) =>
      t.status === WALLET_TXN_UNPROCESSED &&
      t.date === target.date &&
      t.amount === target.amount &&
      t.entry_side === target.type
  );
}

/**
 * 同じ日・同じ金額・同じ向きで、すでに処理済み（消込済み・無視など）の明細を探す。
 *
 * **これがあるのに通常登録へ進むと、同じ支払いが2回入る。** 前回の create_deal が
 * 登録まで終わったあとで失敗を返し、同じ引数で呼び直された場合がこの形になる。
 */
export function findProcessedTwin(
  txns: WalletTxn[],
  target: { date: string; amount: number; type: "income" | "expense" }
): WalletTxn | undefined {
  return txns.find(
    (t) =>
      t.status !== undefined &&
      t.status !== WALLET_TXN_UNPROCESSED &&
      t.date === target.date &&
      t.amount === target.amount &&
      t.entry_side === target.type
  );
}

/**
 * 明細から取引を作るときのリクエストボディ。
 * amount は符号付きで、明細の入出金の向きと同じ向きの取引になる正の値を渡す。
 */
export function buildWalletTxnDealBody(params: {
  issue_date: string;
  amount: number;
  account_item_id: number;
  tax_code: number;
  partner_id?: number;
  description?: string;
}): Record<string, unknown> {
  const line: Record<string, unknown> = {
    account_item_id: params.account_item_id,
    tax_code: params.tax_code,
    amount: params.amount,
  };
  if (params.description) line.description = params.description;

  const body: Record<string, unknown> = {
    issue_date: params.issue_date,
    deal_lines: [line],
  };
  if (params.partner_id) body.partner_id = params.partner_id;
  return body;
}

export async function createDeal(
  client: FreeeClient,
  cache: MasterCache,
  params: CreateDealParams
): Promise<string> {
  // 1. 勘定科目の解決
  const accountResult = await cache.resolveAccountItem(params.account_item);
  if ("candidates" in accountResult) {
    return `エラー: 勘定科目「${params.account_item}」が見つかりません。\n\n候補:\n${accountResult.candidates.map((c) => `  - ${c}`).join("\n")}`;
  }
  const accountItem = accountResult.item;

  // 2. 取引先の解決（指定ありの場合）
  let partnerId: number | undefined;
  let partnerName: string | undefined;

  if (params.partner_name) {
    const partnerResult = await cache.resolvePartner(params.partner_name);

    if (partnerResult === null) {
      // 未登録 → 自動作成
      const newPartner = await cache.createPartner(params.partner_name);
      partnerId = newPartner.id;
      partnerName = newPartner.name;
    } else if ("candidates" in partnerResult) {
      return `エラー: 取引先「${params.partner_name}」が複数該当します。\n\n候補:\n${partnerResult.candidates.map((c) => `  - ${c}`).join("\n")}`;
    } else {
      partnerId = partnerResult.partner.id;
      partnerName = partnerResult.partner.name;
    }
  }

  // 3. 口座の解決（指定ありの場合）
  let walletType: "bank_account" | "credit_card" | "wallet" | undefined;
  let walletId: number | undefined;
  let walletName: string | undefined;

  if (params.wallet_name) {
    const wallet = await cache.resolveWalletable(params.wallet_name);
    if (!wallet) {
      const all = await cache.getWalletables();
      const names = all.map((w) => w.name).join(", ");
      return `エラー: 口座「${params.wallet_name}」が見つかりません。\n登録済み口座: ${names}`;
    }
    walletType = wallet.type;
    walletId = wallet.id;
    walletName = wallet.name;
  }

  const typeName = params.type === "income" ? "収入" : "支出";
  const summary = `  ${params.issue_date} ${typeName} ${formatYen(params.amount)} ${accountItem.name}${partnerName ? ` / ${partnerName}` : ""}${params.description ? ` / ${params.description}` : ""}`;

  // 4. 口座指定がある場合は、まず未処理の明細を探して明細から登録する
  if (walletType && walletId) {
    const res = await client.get<WalletTxnResponse>("/api/1/wallet_txns", {
      walletable_type: walletType,
      walletable_id: walletId,
      start_date: params.issue_date,
      end_date: params.issue_date,
      entry_side: params.type,
      limit: 100,
    });
    const txns = res.wallet_txns ?? [];
    const target = {
      date: params.issue_date,
      amount: params.amount,
      type: params.type,
    };
    const txn = pickWalletTxn(txns, target);

    if (!txn) {
      const twin = findProcessedTwin(txns, target);
      if (twin) {
        return [
          `登録を止めました: ${walletName} の ${params.issue_date} ${formatYen(params.amount)} の明細（ID: ${twin.id}）は、すでに処理済み（status ${twin.status}）です。`,
          `  この支払いの取引がすでにある可能性が高いので、登録すると二重計上になります。list_deals で確かめてください。`,
          `  同じ日に同じ金額の支払いがもう1件あり、その明細がまだ取り込まれていないだけなら、明細が届いてから登録してください。`,
        ].join("\n");
      }
    }

    if (txn) {
      const body = buildWalletTxnDealBody({
        issue_date: params.issue_date,
        amount: params.amount,
        account_item_id: accountItem.id,
        tax_code: accountItem.default_tax_code,
        partner_id: partnerId,
        description: params.description,
      });
      const created = await client.post<WalletTxnCreateDealResponse>(
        `/api/1/wallet_txns/${txn.id}/create_deal`,
        body
      );
      const dealId = created.deal_ids?.[0];

      if (!dealId) {
        return `警告: 明細 ${txn.id} から登録しましたが、取引IDが返りませんでした（応答: ${JSON.stringify(created)}）。freee の画面で確認してください。再実行はしないでください。`;
      }

      // 向きと金額を確かめる。符号の解釈を誤ると収入と支出が入れ替わるが、
      // 貸借は一致したままなので後から気づけない。
      // **確認に失敗しても例外にしない。** 登録は済んでいるので、エラーを返すと
      // 呼び直されて二重計上になる
      let check: DealResponse | undefined;
      try {
        check = await client.get<DealResponse>(`/api/1/deals/${dealId}`);
      } catch (e) {
        return [
          `登録完了 (ID: ${dealId})`,
          summary,
          `  決済: ${walletName}（明細 ${txn.id} と紐付け済み）`,
          `  ※ 登録後の内容確認に失敗しました（${e instanceof Error ? e.message : String(e)}）。登録は済んでいるので再実行しないでください。`,
        ].join("\n");
      }
      if (
        check.deal.type !== params.type ||
        check.deal.amount !== params.amount
      ) {
        return [
          `警告: 明細 ${txn.id} から取引を作りましたが、内容が指定と食い違っています。freee の画面で確認してください。`,
          `  指定: ${typeName} ${formatYen(params.amount)}`,
          `  登録結果 (ID: ${check.deal.id}): ${check.deal.type === "income" ? "収入" : "支出"} ${formatYen(check.deal.amount)}`,
          `  再実行はしないでください（二重計上になります）。`,
        ].join("\n");
      }

      return [
        `登録完了 (ID: ${dealId})`,
        summary,
        `  決済: ${walletName}（明細 ${txn.id} と紐付け済み）`,
      ].join("\n");
    }
  }

  // 5. 明細が無い場合（プライベート資金、または明細がまだ取り込まれていない）
  const body: Record<string, unknown> = {
    type: params.type,
    issue_date: params.issue_date,
    details: [
      {
        account_item_id: accountItem.id,
        tax_code: accountItem.default_tax_code,
        amount: params.amount,
        description: params.description,
      },
    ],
  };

  if (partnerId) {
    body.partner_id = partnerId;
  }

  if (walletType && walletId) {
    body.payments = [
      {
        date: params.issue_date,
        from_walletable_type: walletType,
        from_walletable_id: walletId,
        amount: params.amount,
      },
    ];
  }

  const res = await client.post<DealResponse>("/api/1/deals", body);

  const lines: string[] = [];
  lines.push(`登録完了 (ID: ${res.deal.id})`);
  lines.push(summary);
  if (walletName) {
    lines.push(`  決済: ${walletName}`);
    lines.push(
      `  ※ ${params.issue_date} に ${formatYen(params.amount)} の未処理の明細が ${walletName} に無かったため、明細と紐付いていません。` +
        `明細が取り込まれたら、その明細をこの取引に消し込んでください（そのままだと「自動で経理」で二重に登録されるおそれがあります）。`
    );
  }

  return lines.join("\n");
}
