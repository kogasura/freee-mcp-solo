import { FreeeClient } from "../api/freee-client.js";
import { MasterCache } from "../cache/master-cache.js";
import { formatYen } from "../utils/date-helpers.js";
import { normalizedIncludes } from "../utils/normalize.js";

interface ListInvoicesParams {
  partner_name?: string;
  limit?: number;
}

interface InvoiceSummary {
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

const PAYMENT_MAP: Record<string, string> = {
  unsettled: "入金待ち",
  settled: "入金済み",
};

export async function listInvoices(
  client: FreeeClient,
  cache: MasterCache,
  params: ListInvoicesParams
): Promise<string> {
  const limit = Math.min(params.limit ?? 10, 100);

  const query: Record<string, unknown> = {
    per_page: limit,
    cancel_status: "uncanceled",
  };

  const res = await client.getInvoice<InvoicesResponse>("/invoices", query);
  let invoices = res.invoices ?? [];

  // 取引先名でクライアント側フィルタ（APIにpartner_name検索がないため）
  if (params.partner_name) {
    invoices = invoices.filter((i) =>
      normalizedIncludes(
        i.partner_display_name ?? i.partner_name ?? "",
        params.partner_name!
      )
    );
  }

  if (invoices.length === 0) {
    return "請求書が見つかりません。";
  }

  const lines: string[] = [];
  lines.push(`## 請求書一覧（${invoices.length}件）`);
  lines.push("");

  for (let i = 0; i < invoices.length; i++) {
    const inv = invoices[i];
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
