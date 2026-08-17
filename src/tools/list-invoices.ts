import { FreeeClient } from "../api/freee-client.js";
import { MasterCache } from "../cache/master-cache.js";
import { formatYen } from "../utils/date-helpers.js";
import { normalizedIncludes } from "../utils/normalize.js";

interface ListInvoicesParams {
  partner_name?: string;
  limit?: number;
}

export interface InvoiceSummary {
  id: number;
  invoice_number: string;
  billing_date: string;
  payment_date: string;
  total_amount: number;
  sending_status: string;
  payment_status: string;
  partner_display_name?: string;
  partner_name?: string;
  subject: string;
}

interface InvoicesResponse {
  invoices: InvoiceSummary[];
}

const SENDING_MAP: Record<string, string> = {
  unsent: "未送付",
  sent: "送付済み",
};

/// freee が1ページに返す請求書の件数。
///
/// **`per_page` を大きくしても増えない。** 20件で固定されている。
const PAGE_SIZE = 20;

/// 辿るページ数の上限（20件 × 100 = 2,000件）。
///
/// **無限に回らないための歯止め**であって、これに当たることを想定して
/// いない。当たったら上限を上げるのではなく、期間で絞る手段を足すこと。
const MAX_PAGES = 100;

const PAYMENT_MAP: Record<string, string> = {
  unsettled: "入金待ち",
  settled: "入金済み",
};

/**
 * ページを辿って請求書を集める。
 *
 * # なぜ要るのか
 *
 * **`per_page` を大きくしても freee は1ページ20件しか返さない。**
 * 以前は1回引いて打ち切っており、**新しい順に20件しか見えていなかった**。
 * 実帳簿では2025年12月より後の請求書10件が丸ごと隠れており、売掛金を
 * 数えようとして「2026年分が1件も無い」ことで気づいた。
 *
 * **黙って途中で切れる読み取りは、無いのと同じか、それより悪い。**
 * 「請求書は20件」と読めてしまう。
 *
 * # 打ち切りの規則
 *
 * 返ってきた件数がページ未満なら最後である。**件数で判断しないと、
 * ちょうど割り切れたときに空ページを1回余分に引く。**
 *
 * 上限に達したらそこで止める。取り切れないほど多い帳簿で無限に回らない
 * よう、周回数にも上限を置く。
 */
export async function fetchAllInvoices(
  fetchPage: (offset: number) => Promise<InvoiceSummary[]>,
  limit: number
): Promise<InvoiceSummary[]> {
  const all: InvoiceSummary[] = [];
  for (let page = 0; page < MAX_PAGES && all.length < limit; page++) {
    const got = await fetchPage(page * PAGE_SIZE);
    all.push(...got);
    if (got.length < PAGE_SIZE) break;
  }
  return all.slice(0, limit);
}

export async function listInvoices(
  client: FreeeClient,
  cache: MasterCache,
  params: ListInvoicesParams
): Promise<string> {
  const limit = Math.min(params.limit ?? 10, 500);

  const invoices = await fetchAllInvoices(
    (offset) =>
      client
        .getInvoice<InvoicesResponse>("/invoices", {
          per_page: PAGE_SIZE,
          offset,
          cancel_status: "uncanceled",
        })
        .then((res) => res.invoices ?? []),
    limit
  );
  let filtered = invoices;

  // 取引先名でクライアント側フィルタ（APIにpartner_name検索がないため）
  if (params.partner_name) {
    filtered = filtered.filter((i) =>
      normalizedIncludes(
        i.partner_display_name ?? i.partner_name ?? "",
        params.partner_name!
      )
    );
  }

  if (filtered.length === 0) {
    return "請求書が見つかりません。";
  }

  const lines: string[] = [];
  lines.push(`## 請求書一覧（${filtered.length}件）`);
  lines.push("");

  for (let i = 0; i < filtered.length; i++) {
    const inv = filtered[i];
    const sending = SENDING_MAP[inv.sending_status] ?? inv.sending_status;
    const payment = PAYMENT_MAP[inv.payment_status] ?? inv.payment_status;
    const displayName = inv.partner_display_name ?? inv.partner_name ?? "不明";
    const statusText = [sending, payment].filter(Boolean).join("・");

    lines.push(
      `#${i + 1} (id:${inv.id}) ${inv.billing_date} ${displayName} ${formatYen(inv.total_amount)} ${statusText}`
    );
    if (inv.subject) lines.push(`     ${inv.subject}`);
  }

  return lines.join("\n");
}
