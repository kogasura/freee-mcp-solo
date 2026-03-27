import { FreeeClient } from "../api/freee-client.js";
import { MasterCache } from "../cache/master-cache.js";
import type { DealResponse } from "../api/types.js";
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
  let walletType: string | undefined;
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

  // 4. リクエストボディの構築
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

  // 口座指定がある場合は payments を追加
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

  // 5. API実行
  const res = await client.post<DealResponse>("/api/1/deals", body);

  // 6. 結果整形
  const typeName = params.type === "income" ? "収入" : "支出";
  const lines: string[] = [];
  lines.push(`登録完了 (ID: ${res.deal.id})`);
  lines.push(
    `  ${params.issue_date} ${typeName} ${formatYen(params.amount)} ${accountItem.name}${partnerName ? ` / ${partnerName}` : ""}${params.description ? ` / ${params.description}` : ""}`
  );
  if (walletName) {
    lines.push(`  決済: ${walletName}`);
  }

  return lines.join("\n");
}
