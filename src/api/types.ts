// freee API レスポンス型定義

export interface WalletTxn {
  id: number;
  date: string;
  entry_side: "income" | "expense";
  amount: number;
  due_amount: number;
  balance: number;
  description: string;
  walletable_type: "bank_account" | "credit_card" | "wallet";
  walletable_id: number;
}

export interface WalletTxnResponse {
  wallet_txns: WalletTxn[];
}

export interface Walletable {
  id: number;
  name: string;
  type: "bank_account" | "credit_card" | "wallet";
  walletable_balance?: number;
  last_balance?: number;
  last_synced_at?: string;
}

export interface WalletableResponse {
  walletables: Walletable[];
}

export interface DealDetail {
  id?: number;
  account_item_id: number;
  tax_code: number;
  amount: number;
  description?: string;
  vat?: number;
  account_item_name?: string;
}

export interface DealPayment {
  date: string;
  from_walletable_type: string;
  from_walletable_id: number;
  amount: number;
}

export interface Deal {
  id: number;
  type: "income" | "expense";
  issue_date: string;
  due_date?: string;
  amount: number;
  due_amount: number;
  partner_id?: number;
  ref_number?: string;
  details: DealDetail[];
  payments?: DealPayment[];
}

export interface DealResponse {
  deal: Deal;
}

export interface DealsResponse {
  deals: Deal[];
  meta?: { total_count: number };
}

export interface AccountItem {
  id: number;
  name: string;
  shortcut1?: string;
  shortcut2?: string;
  default_tax_code: number;
  categories: string[];
  group_name?: string;
  available: boolean;
}

export interface AccountItemsResponse {
  account_items: AccountItem[];
}

export interface Partner {
  id: number;
  name: string;
  code?: string;
  shortcut1?: string;
  shortcut2?: string;
}

export interface PartnersResponse {
  partners: Partner[];
}

export interface PartnerResponse {
  partner: Partner;
}

export interface TaxCode {
  code: number;
  name: string;
  name_ja: string;
  rate: number;
  available: boolean;
}
