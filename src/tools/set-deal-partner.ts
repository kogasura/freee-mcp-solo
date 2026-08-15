import { FreeeClient } from "../api/freee-client.js";

/**
 * 既存の取引に取引先を設定する。
 *
 * # なぜ要るのか
 *
 * 適格請求書が要る税区分の仕訳でも、相手方が記録されていないと帳簿から
 * 誰の請求書か辿れない。2026年1〜8月の 684 取引のうち取引先が入っているのは
 * 44 件だけだった。kaikei 側は同期で `counterparty` タグを載せるようになった
 * ので、freee 側に取引先を入れれば帳簿にも載る。
 *
 * # 全置換であることの危険
 *
 * freee の取引更新は **PUT による全置換**である。`details` を渡さなければ
 * 明細が消え、`payments` を渡さなければ決済の紐付けが外れる（口座明細との
 * 対応が切れる）。ここでは**取得した内容をすべて写してから `partner_id`
 * だけを差し替える**。写し漏れがあると、決済済みの取引が壊れる。
 *
 * # 既定は下見
 *
 * `commit` が無ければ、何をどう変えるかを見せるだけで送信しない。
 */
interface DealDetail {
  id: number;
  account_item_id: number;
  tax_code: number;
  amount: number;
  vat?: number;
  description?: string;
  entry_side: string;
  item_id?: number | null;
  section_id?: number | null;
  tag_ids?: number[];
}

interface DealPayment {
  id: number;
  date: string;
  from_walletable_type?: string;
  from_walletable_id?: number;
  amount: number;
}

export interface Deal {
  id: number;
  company_id: number;
  issue_date: string;
  due_date?: string | null;
  type: string;
  amount?: number;
  partner_id?: number | null;
  ref_number?: string | null;
  status?: string;
  details: DealDetail[];
  payments?: DealPayment[];
}

/**
 * 取引を更新するための本文を組み立てる。
 *
 * **取得した内容をそのまま写す。** 変えるのは `partner_id` だけ。
 * 省略した属性は freee 側で消えるため、`details` と `payments` は必ず載せる。
 */
export function buildUpdateBody(
  deal: Deal,
  partnerId: number
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    company_id: deal.company_id,
    issue_date: deal.issue_date,
    type: deal.type,
    partner_id: partnerId,
    details: deal.details.map((detail) => ({
      id: detail.id,
      account_item_id: detail.account_item_id,
      tax_code: detail.tax_code,
      amount: detail.amount,
      ...(detail.vat === undefined ? {} : { vat: detail.vat }),
      description: detail.description ?? "",
      entry_side: detail.entry_side,
      ...(detail.item_id ? { item_id: detail.item_id } : {}),
      ...(detail.section_id ? { section_id: detail.section_id } : {}),
      ...(detail.tag_ids?.length ? { tag_ids: detail.tag_ids } : {}),
    })),
  };
  if (deal.due_date) body.due_date = deal.due_date;
  if (deal.ref_number) body.ref_number = deal.ref_number;
  // **決済を落とさない。** 渡さないと決済済みの取引が未決済に戻り、
  // 口座明細との紐付けが外れる。
  if (deal.payments?.length) {
    body.payments = deal.payments.map((payment) => ({
      id: payment.id,
      date: payment.date,
      amount: payment.amount,
      ...(payment.from_walletable_type
        ? { from_walletable_type: payment.from_walletable_type }
        : {}),
      ...(payment.from_walletable_id
        ? { from_walletable_id: payment.from_walletable_id }
        : {}),
    }));
  }
  return body;
}

/**
 * 更新の前後で、取引先以外が変わっていないかを調べる。
 *
 * **成功したと言う前に確かめる。** 全置換なので、写し漏れがあれば明細や
 * 決済が消える。消えたことに気づかないまま次の取引へ進むのが最悪である。
 */
export function whatChangedBesidesPartner(before: Deal, after: Deal): string[] {
  const problems: string[] = [];
  if (before.issue_date !== after.issue_date) problems.push("取引日");
  if (before.type !== after.type) problems.push("収支区分");
  if (before.status !== after.status) {
    problems.push(`状態（${before.status} → ${after.status}）`);
  }
  if (before.details.length !== after.details.length) {
    problems.push(
      `明細の件数（${before.details.length} → ${after.details.length}）`
    );
  } else {
    for (const [index, was] of before.details.entries()) {
      const now = after.details[index];
      if (was.amount !== now.amount) problems.push(`明細${index + 1}の金額`);
      if (was.account_item_id !== now.account_item_id) {
        problems.push(`明細${index + 1}の勘定科目`);
      }
      if (was.tax_code !== now.tax_code) problems.push(`明細${index + 1}の税区分`);
      if ((was.description ?? "") !== (now.description ?? "")) {
        problems.push(`明細${index + 1}の摘要`);
      }
    }
  }
  const beforePayments = before.payments?.length ?? 0;
  const afterPayments = after.payments?.length ?? 0;
  if (beforePayments !== afterPayments) {
    problems.push(`決済の件数（${beforePayments} → ${afterPayments}）`);
  }
  return problems;
}

interface SetDealPartnerParams {
  /** 対象の取引ID（カンマ区切り）。 */
  deal_ids: string;
  /** 設定する取引先ID。 */
  partner_id: number;
  /** 実際に送信する。既定は下見。 */
  commit?: boolean;
}

export async function setDealPartner(
  client: FreeeClient,
  params: SetDealPartnerParams
): Promise<string> {
  const ids = params.deal_ids
    .split(",")
    .map((text) => Number(text.trim()))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) {
    return "deal_ids に取引IDを指定してください（カンマ区切り）";
  }

  const lines: string[] = [];
  let updated = 0;
  for (const id of ids) {
    const before = (await client.get<{ deal: Deal }>(`/api/1/deals/${id}`, {}))
      .deal;
    const description = before.details
      .map((detail) => detail.description)
      .filter(Boolean)
      .join(" / ");
    const head = `#${id} ${before.issue_date} ¥${before.amount ?? before.details.reduce((sum, d) => sum + d.amount, 0)} ${description}`;

    if (before.partner_id) {
      lines.push(`${head} → 既に取引先が入っているので触りません`);
      continue;
    }
    if (!params.commit) {
      lines.push(`${head} → 取引先 ${params.partner_id} を設定します（下見）`);
      continue;
    }

    const body = buildUpdateBody(before, params.partner_id);
    await client.put(`/api/1/deals/${id}`, body);
    const after = (await client.get<{ deal: Deal }>(`/api/1/deals/${id}`, {}))
      .deal;

    const problems = whatChangedBesidesPartner(before, after);
    if (problems.length > 0) {
      lines.push(
        `${head} → **取引先以外も変わりました: ${problems.join("、")}。以降を中止します**`
      );
      return lines.join("\n");
    }
    if (after.partner_id !== params.partner_id) {
      lines.push(`${head} → 取引先が設定されていません。以降を中止します`);
      return lines.join("\n");
    }
    lines.push(`${head} → 設定しました`);
    updated++;
  }

  if (!params.commit) {
    lines.push("");
    lines.push("下見です。送信していません。実行するには commit を付けてください。");
    lines.push(
      "（freee の取引更新は全置換です。明細と決済はそのまま写します）"
    );
  } else {
    lines.push("");
    lines.push(`${updated} 件を更新しました。取引先以外は変わっていません`);
  }
  return lines.join("\n");
}
