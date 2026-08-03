import { FreeeClient } from "../api/freee-client.js";
import { MasterCache } from "../cache/master-cache.js";
import {
  loadInvoiceConfig,
  getPartnerConfig,
  calculateDueDate,
  expandSubjectTemplate,
  applyHonorific,
} from "../config/invoice-config.js";
import { formatYen } from "../utils/date-helpers.js";

interface InvoiceItem {
  description: string;
  qty: number;
  unit?: string;
  unit_price: number;
  tax_rate?: number; // デフォルト10。軽減税率の場合は8を指定
}

interface CreateInvoiceParams {
  partner_name: string;
  issue_date: string;
  due_date?: string;
  subject?: string;
  items: InvoiceItem[];
}

interface InvoiceApiResponse {
  invoice: {
    id: number;
    invoice_number: string;
    billing_date: string;
    payment_date: string;
    total_amount: number;
    amount_excluding_tax: number;
    amount_tax: number;
    partner_display_name: string;
    sending_status: string;
    subject: string;
  };
}

export async function createInvoice(
  client: FreeeClient,
  cache: MasterCache,
  params: CreateInvoiceParams
): Promise<string> {
  const config = await loadInvoiceConfig();

  // 取引先の解決
  const partnerResult = await cache.resolvePartner(params.partner_name);
  let partnerId: number;
  let partnerDisplayName: string;
  let partnerDefaultTitle: string | undefined;
  let partnerContactName: string | undefined;

  if (partnerResult === null) {
    return `エラー: 取引先「${params.partner_name}」が見つかりません。freeeに取引先を登録してください。`;
  } else if ("candidates" in partnerResult) {
    return `エラー: 取引先「${params.partner_name}」が複数該当します。\n\n候補:\n${partnerResult.candidates.map((c) => `  - ${c}`).join("\n")}`;
  } else {
    partnerId = partnerResult.partner.id;
    partnerDisplayName = partnerResult.partner.name;
    partnerDefaultTitle = partnerResult.partner.default_title;
    partnerContactName = partnerResult.partner.contact_name;
  }

  // 取引先設定の取得。宛名の敬称は 設定ファイル > 取引先マスタ > 既定値 の順で採用する
  const partnerConfig = getPartnerConfig(config, partnerDisplayName);
  const partnerTitle =
    partnerConfig?.partner_title ||
    partnerDefaultTitle ||
    config.invoice.default_partner_title;

  // 取引先の担当者名に敬称を付ける（マスタ側が敬称なしでも請求書には付く）
  const contactName = applyHonorific(
    partnerContactName ?? "",
    config.invoice.contact_honorific
  );

  // 入金期日の計算
  let dueDate = params.due_date;
  if (!dueDate && partnerConfig?.due_date_rule) {
    dueDate = calculateDueDate(params.issue_date, partnerConfig.due_date_rule);
  }
  if (!dueDate) {
    return "エラー: 入金期日を指定してください。due_date パラメータ、または config.yaml の partners 設定で due_date_rule を設定できます。";
  }

  // 件名の生成
  let subject = params.subject;
  if (!subject && partnerConfig?.subject_template) {
    subject = expandSubjectTemplate(
      partnerConfig.subject_template,
      params.issue_date
    );
  }

  // 明細行の構築（請求書API仕様に合わせる）
  const lines = params.items.map((item) => ({
    type: "item",
    description: item.description,
    sales_date: params.issue_date,
    unit: item.unit ?? "式",
    quantity: item.qty,
    unit_price: Number(item.unit_price).toFixed(1),
    tax_rate: item.tax_rate ?? 10,
    reduced_tax_rate: (item.tax_rate ?? 10) === 8,
    withholding: false,
  }));

  // リクエストボディの構築（請求書API /iv/invoices 仕様）
  const body: Record<string, unknown> = {
    partner_id: partnerId,
    partner_display_name: partnerDisplayName,
    partner_title: partnerTitle,
    billing_date: params.issue_date,
    ...(contactName ? { partner_contact_name: contactName } : {}),
    ...(config.invoice.company_contact_name
      ? { company_contact_name: config.invoice.company_contact_name }
      : {}),
    payment_date: dueDate,
    subject: subject ?? "",
    payment_type: "transfer",
    tax_entry_method: config.invoice.tax_entry_method === "exclusive" ? "out" : "in",
    tax_fraction: "omit",
    withholding_tax_entry_method: "out",
    lines,
  };

  // API実行
  const res = await client.postInvoice<InvoiceApiResponse>("/invoices", body);
  const inv = res.invoice;

  // 結果整形
  const lines2: string[] = [];
  lines2.push(`請求書を作成しました (ID: ${inv.id})`);
  lines2.push(`  請求番号: ${inv.invoice_number}`);
  lines2.push(`  請求先: ${inv.partner_display_name} ${partnerTitle}`);
  if (contactName) lines2.push(`  担当者: ${contactName}`);
  if (config.invoice.company_contact_name)
    lines2.push(`  自社担当者: ${config.invoice.company_contact_name}`);
  lines2.push(`  請求日: ${inv.billing_date}`);
  lines2.push(`  入金期日: ${inv.payment_date}`);
  if (subject) lines2.push(`  件名: ${subject}`);
  lines2.push(
    `  金額: ${formatYen(inv.amount_excluding_tax)}（税抜） / ${formatYen(inv.total_amount)}（税込）`
  );
  lines2.push(`  ステータス: 送付待ち`);

  return lines2.join("\n");
}
