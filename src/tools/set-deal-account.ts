import { FreeeClient } from "../api/freee-client.js";
import { MasterCache } from "../cache/master-cache.js";
import { Deal, buildUpdateBody } from "./set-deal-partner.js";

/**
 * 既存の取引の**勘定科目**を差し替える。
 *
 * # なぜ要るのか
 *
 * 科目の当て間違いは**貸借対照表だけを狂わせる**ことがある。実際、
 * 2026-03-26 のカード引落し 90,057円 が「未払金」ではなく「事業主貸」に
 * 計上されていた。他の月（1・2・5・6・7月）はすべて未払金なので、
 * この月だけが例外である。
 *
 * この形の誤りは**貸借が一致したまま**なので、決算書を見ても気づけない。
 * 過年度の減価償却で相手科目を間違えていたのと同じ類である。
 *
 * # 取引を消して作り直さない
 *
 * 消して作り直すと**取引IDが変わる**。口座明細との紐付けも作り直しになり、
 * 失敗すれば決済済みが未決済に戻る。更新なら紐付けが残る。
 *
 * # 全置換であることの危険（`set_deal_partner` と同じ）
 *
 * freee の取引更新は **PUT による全置換**である。`details` を渡さなければ
 * 明細が消え、`payments` を渡さなければ決済の紐付けが外れる。本文の
 * 組み立ては [`buildUpdateBody`] を共有する——**同じ危険に2つの実装を
 * 持たない。**
 *
 * # 明細が1件の取引だけを扱う
 *
 * 複数明細の取引で「どの明細を差し替えるか」を指定させると、指定を誤ったとき
 * 別の明細を書き換える。**明細が2件以上あれば断る。** 必要になったら、
 * 明細を選ぶ手段を設計してから足すこと。
 *
 * # 既定は下見
 *
 * `commit` が無ければ、何をどう変えるかを見せるだけで送信しない。
 */
interface SetDealAccountParams {
  /** 対象の取引ID。 */
  deal_id: number;
  /** 差し替え後の勘定科目名（例: 未払金）。 */
  account_item: string;
  /** 実際に送信する。既定は下見。 */
  commit?: boolean;
}

/**
 * 科目を差し替えた本文を組み立てる。
 *
 * **`buildUpdateBody` の結果を加工する。** 取引先はそのまま保つ
 * （`partner_id` が無ければ `null` を渡さず、キーごと落とす）。
 */
export function buildAccountUpdateBody(
  deal: Deal,
  accountItemId: number
): Record<string, unknown> {
  const body = buildUpdateBody(deal, deal.partner_id ?? 0);
  if (!deal.partner_id) delete body.partner_id;
  const details = body.details as Record<string, unknown>[];
  body.details = details.map((detail) => ({
    ...detail,
    account_item_id: accountItemId,
  }));
  return body;
}

/**
 * 更新の前後で、勘定科目以外が変わっていないかを調べる。
 *
 * **成功したと言う前に確かめる。** 全置換なので写し漏れがあれば明細や決済が
 * 消える。消えたことに気づかないまま次へ進むのが最悪である。
 */
export function whatChangedBesidesAccount(before: Deal, after: Deal): string[] {
  const problems: string[] = [];
  if (before.issue_date !== after.issue_date) problems.push("取引日");
  if (before.type !== after.type) problems.push("収支区分");
  if (before.status !== after.status) {
    problems.push(`状態（${before.status} → ${after.status}）`);
  }
  if ((before.partner_id ?? null) !== (after.partner_id ?? null)) {
    problems.push("取引先");
  }
  if (before.details.length !== after.details.length) {
    problems.push(
      `明細の件数（${before.details.length} → ${after.details.length}）`
    );
  } else {
    for (const [index, was] of before.details.entries()) {
      const now = after.details[index];
      if (was.amount !== now.amount) problems.push(`明細${index + 1}の金額`);
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

export async function setDealAccount(
  client: FreeeClient,
  cache: MasterCache,
  params: SetDealAccountParams
): Promise<string> {
  const accounts = await cache.getAccountItems();
  const target = accounts.find((item) => item.name === params.account_item);
  if (!target) {
    return `勘定科目「${params.account_item}」が見つかりません。名前を確かめてください`;
  }

  const before = (
    await client.get<{ deal: Deal }>(`/api/1/deals/${params.deal_id}`, {})
  ).deal;

  if (before.details.length !== 1) {
    return (
      `#${params.deal_id} は明細が ${before.details.length} 件あります。` +
      `どの明細を差し替えるか決められないので断ります。`
    );
  }

  const detail = before.details[0];
  const was = accounts.find((item) => item.id === detail.account_item_id);
  const lines: string[] = [
    `#${params.deal_id} ${before.issue_date} ¥${detail.amount.toLocaleString("ja-JP")} ${detail.description ?? ""}`,
    `  ${was?.name ?? detail.account_item_id} → ${target.name}`,
  ];

  if (detail.account_item_id === target.id) {
    lines.push("  既にこの科目です。何もしません");
    return lines.join("\n");
  }

  if (!params.commit) {
    lines.push("");
    lines.push("下見です。実際に変えるには commit を付けてください。");
    return lines.join("\n");
  }

  await client.put(`/api/1/deals/${params.deal_id}`, buildAccountUpdateBody(before, target.id));

  // ★変えた後に読み直して、科目以外が変わっていないことを確かめる★
  const after = (
    await client.get<{ deal: Deal }>(`/api/1/deals/${params.deal_id}`, {})
  ).deal;
  const problems = whatChangedBesidesAccount(before, after);
  if (problems.length > 0) {
    lines.push(`  **科目以外が変わりました: ${problems.join(" / ")}**`);
    lines.push("  freee の画面で中身を確かめてください。");
    return lines.join("\n");
  }
  if (after.details[0]?.account_item_id !== target.id) {
    lines.push("  **科目が変わっていません。** freee の画面で確かめてください。");
    return lines.join("\n");
  }
  lines.push("  変更しました（科目以外は変わっていません）");
  return lines.join("\n");
}
