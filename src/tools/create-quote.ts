import { FreeeClient } from "../api/freee-client.js";
import { MasterCache } from "../cache/master-cache.js";
import {
  loadInvoiceConfig,
  getPartnerConfig,
  applyHonorific,
} from "../config/invoice-config.js";
import { formatYen } from "../utils/date-helpers.js";

interface QuoteItem {
  description: string;
  qty?: number;
  unit?: string;
  unit_price?: number;
  tax_rate?: number; // デフォルト10。軽減税率の場合は8を指定
  /**
   * 項目の説明。指定すると、この項目の直後に**テキスト行**を1本入れる。
   * freee の明細に「内容」列は無いが、テキスト行なら摘要列に文が入る
   * （数量・単価・金額は空欄になる。2026-09-15 に実測）。
   */
  note?: string;
}

interface CreateQuoteParams {
  partner_name: string;
  quote_date: string;
  expiration_date?: string;
  subject?: string;
  items: QuoteItem[];
  quotation_note?: string;
  delivery_deadline?: string;
  delivery_location?: string;
}

interface QuotationApiResponse {
  quotation: {
    id: number;
    quotation_number: string;
    quotation_date: string;
    expiration_date: string;
    total_amount: number;
    amount_excluding_tax: number;
    amount_tax: number;
    partner_display_name: string;
    subject: string;
    report_url: string;
  };
}

/**
 * テキスト行が1行に収まる上限の幅（全角1・半角0.5 で数えた値）。
 *
 * **freee は説明行の高さを広げてくれない。** 収まらなかったぶんは2行目に
 * はみ出し、行の枠からずれて見える。2026-09-15 に実測したところ、幅57.5 は
 * 収まり、幅59.5 は溢れた。書体がプロポーショナル（IPA Pゴシック）で
 * 括弧などの実幅が読めないため、安全側に倒して 48 とする。
 */
const NOTE_MAX_WIDTH = 48;

/** 全角を1、半角を0.5 として文字列の幅を数える。 */
function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0x303e) ||
      (c >= 0x3041 && c <= 0x33ff) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0xa000 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    w += wide ? 1 : 0.5;
  }
  return w;
}

/**
 * 説明文を、1行に収まる幅で分ける。
 *
 * 句読点や区切り記号の直後で切る。区切りが無ければ幅で強制的に切る
 * （URL や長い英単語が続く場合。切らずに送ると崩れる方が困る）。
 */
export function splitNote(note: string, maxWidth = NOTE_MAX_WIDTH): string[] {
  const BREAK_AFTER = "、。，．・／/｜|）)】」』";
  const out: string[] = [];
  let rest = note.trim().replace(/\s+/g, " ");

  while (textWidth(rest) > maxWidth) {
    // 幅の上限に収まる範囲を切り出す
    let cut = 0;
    let w = 0;
    for (const ch of rest) {
      const cw = textWidth(ch);
      if (w + cw > maxWidth) break;
      w += cw;
      cut += ch.length;
    }
    // その範囲の中で、最後に現れる区切りの直後まで戻す
    let at = -1;
    for (let i = cut - 1; i >= 0; i--) {
      if (BREAK_AFTER.includes(rest[i]) || rest[i] === " ") {
        at = i + 1;
        break;
      }
    }
    // 戻しすぎると短い行が並ぶので、半分未満までしか戻さない
    if (at < cut / 2) at = cut;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** 見積日から既定の有効期限（1か月後の同日）を出す。月末は翌月末に丸める。 */
function defaultExpirationDate(quoteDate: string): string {
  const [y, m, d] = quoteDate.split("-").map(Number);
  // Date の月跨ぎ補正に任せると 1/31 → 3/3 になるため、月末を自前で抑える
  const targetYear = m === 12 ? y + 1 : y;
  const targetMonth = m === 12 ? 1 : m + 1;
  const lastDay = new Date(targetYear, targetMonth, 0).getDate();
  const day = Math.min(d, lastDay);
  const mm = String(targetMonth).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${targetYear}-${mm}-${dd}`;
}

export async function createQuote(
  client: FreeeClient,
  cache: MasterCache,
  params: CreateQuoteParams
): Promise<string> {
  const config = await loadInvoiceConfig();

  // 取引先の解決（請求書と同じ規則。見つからない・複数該当は作らずに止める）
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

  const partnerConfig = getPartnerConfig(config, partnerDisplayName);
  const partnerTitle =
    partnerConfig?.partner_title ||
    partnerDefaultTitle ||
    config.invoice.default_partner_title;

  const contactName = applyHonorific(
    partnerContactName ?? "",
    config.invoice.contact_honorific
  );

  const expirationDate =
    params.expiration_date ?? defaultExpirationDate(params.quote_date);

  // 明細行の構築。note があれば、その項目の直後にテキスト行を足す
  const lines: Record<string, unknown>[] = [];
  for (const item of params.items) {
    if (item.unit_price === undefined || item.qty === undefined) {
      return `エラー: 明細「${item.description}」に数量または単価がありません。金額の無い行を入れたいときは、前の項目の note に書いてください。`;
    }
    const taxRate = item.tax_rate ?? 10;
    lines.push({
      type: "item",
      description: item.description,
      unit: item.unit ?? "式",
      quantity: item.qty,
      unit_price: Number(item.unit_price).toFixed(1),
      tax_rate: taxRate,
      reduced_tax_rate: taxRate === 8,
      withholding: false,
    });
    if (item.note) {
      for (const part of splitNote(item.note)) {
        lines.push({ type: "text", description: part });
      }
    }
  }

  if (lines.length === 0) {
    return "エラー: 明細が1行もありません。";
  }

  const body: Record<string, unknown> = {
    partner_id: partnerId,
    partner_display_name: partnerDisplayName,
    partner_title: partnerTitle,
    quotation_date: params.quote_date,
    expiration_date: expirationDate,
    ...(contactName ? { partner_contact_name: contactName } : {}),
    ...(config.invoice.company_contact_name
      ? { company_contact_name: config.invoice.company_contact_name }
      : {}),
    subject: params.subject ?? "",
    tax_entry_method: config.invoice.tax_entry_method === "exclusive" ? "out" : "in",
    tax_fraction: "omit",
    withholding_tax_entry_method: "out",
    ...(params.quotation_note ? { quotation_note: params.quotation_note } : {}),
    ...(params.delivery_deadline
      ? { delivery_deadline: params.delivery_deadline }
      : {}),
    ...(params.delivery_location
      ? { delivery_location: params.delivery_location }
      : {}),
    lines,
  };

  const res = await client.postInvoice<QuotationApiResponse>("/quotations", body);
  const q = res.quotation;

  const out: string[] = [];
  out.push(`見積書を作成しました (ID: ${q.id})`);
  out.push(`  見積番号: ${q.quotation_number}`);
  out.push(`  宛先: ${q.partner_display_name} ${partnerTitle}`);
  if (contactName) out.push(`  担当者: ${contactName}`);
  out.push(`  見積日: ${q.quotation_date}`);
  out.push(`  有効期限: ${q.expiration_date}`);
  if (q.subject) out.push(`  件名: ${q.subject}`);
  out.push(
    `  金額: ${formatYen(q.amount_excluding_tax)}（税抜） / ${formatYen(q.total_amount)}（税込）`
  );
  out.push(`  明細: ${params.items.length} 項目`);
  out.push(`  URL: ${q.report_url}`);

  return out.join("\n");
}
