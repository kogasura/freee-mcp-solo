import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse, stringify } from "yaml";

const CONFIG_DIR = join(homedir(), ".config", "freee-mcp-solo");
const CONFIG_PATH = join(CONFIG_DIR, "config.yaml");

export interface PartnerConfig {
  due_date_rule?: string;
  partner_title?: string;
  subject_template?: string;
}

export interface InvoiceConfig {
  payment: {
    bank_info: string;
  };
  invoice: {
    tax_entry_method: "exclusive" | "inclusive";
    default_account_item: string;
    default_tax_code_name: string;
    layout: string;
    message: string;
    notes: string;
  };
  partners: Record<string, PartnerConfig>;
}

const DEFAULT_CONFIG: InvoiceConfig = {
  payment: {
    bank_info: "",
  },
  invoice: {
    tax_entry_method: "exclusive",
    default_account_item: "売上高",
    default_tax_code_name: "課税売上10%",
    layout: "default_classic",
    message: "下記の通りご請求申し上げます。",
    notes: "",
  },
  partners: {},
};

export async function loadInvoiceConfig(): Promise<InvoiceConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const parsed = parse(raw) as Partial<InvoiceConfig>;
    return {
      payment: { ...DEFAULT_CONFIG.payment, ...parsed.payment },
      invoice: { ...DEFAULT_CONFIG.invoice, ...parsed.invoice },
      partners: parsed.partners ?? {},
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveInvoiceConfig(config: InvoiceConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, stringify(config, { lineWidth: 0 }), "utf-8");
}

export function getPartnerConfig(
  config: InvoiceConfig,
  partnerName: string
): PartnerConfig | null {
  // 完全一致
  if (config.partners[partnerName]) return config.partners[partnerName];

  // 部分一致
  for (const [key, value] of Object.entries(config.partners)) {
    if (partnerName.includes(key) || key.includes(partnerName)) {
      return value;
    }
  }
  return null;
}

/** due_date_rule から実際の期日を計算する */
export function calculateDueDate(
  issueDate: string,
  rule: string
): string {
  const d = new Date(issueDate + "T00:00:00"); // ローカルタイムゾーンとして解釈

  // "+2months_15" → 2ヶ月後の15日
  const monthsDayMatch = rule.match(/^\+(\d+)months?_(\d+)$/);
  if (monthsDayMatch) {
    const months = parseInt(monthsDayMatch[1], 10);
    const day = parseInt(monthsDayMatch[2], 10);
    d.setMonth(d.getMonth() + months);
    d.setDate(day);
    return formatDate(d);
  }

  // "+1month_end" → 翌月末
  const monthEndMatch = rule.match(/^\+(\d+)months?_end$/);
  if (monthEndMatch) {
    const months = parseInt(monthEndMatch[1], 10);
    d.setMonth(d.getMonth() + months + 1, 0); // 翌月の0日 = 当月末
    return formatDate(d);
  }

  // "+30days" → N日後
  const daysMatch = rule.match(/^\+(\d+)days$/);
  if (daysMatch) {
    const days = parseInt(daysMatch[1], 10);
    d.setDate(d.getDate() + days);
    return formatDate(d);
  }

  return issueDate; // パースできなければ請求日をそのまま返す
}

/** subject_template を展開する */
export function expandSubjectTemplate(
  template: string,
  issueDate: string
): string {
  const d = new Date(issueDate + "T00:00:00");
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return template
    .replace(/\{YY\}/g, yy)
    .replace(/\{YYYY\}/g, String(d.getFullYear()))
    .replace(/\{MM\}/g, mm)
    .replace(/\{M\}/g, String(d.getMonth() + 1));
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
