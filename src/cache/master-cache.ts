import { FreeeClient } from "../api/freee-client.js";
import type {
  AccountItem,
  AccountItemsResponse,
  Partner,
  PartnersResponse,
  Walletable,
  WalletableResponse,
} from "../api/types.js";
import { normalizedEquals, normalizedIncludes, toHalfWidth } from "../utils/normalize.js";

const TTL_MS = 10 * 60 * 1000; // 10分

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

export class MasterCache {
  private accountItems: CacheEntry<AccountItem[]> | null = null;
  private partners: CacheEntry<Partner[]> | null = null;
  private walletables: CacheEntry<Walletable[]> | null = null;

  constructor(private client: FreeeClient) {}

  // ── 勘定科目 ──

  async getAccountItems(): Promise<AccountItem[]> {
    if (this.accountItems && Date.now() - this.accountItems.fetchedAt < TTL_MS) {
      return this.accountItems.data;
    }
    const res = await this.client.get<AccountItemsResponse>(
      "/api/1/account_items"
    );
    const items = res.account_items.filter((a) => a.available);
    this.accountItems = { data: items, fetchedAt: Date.now() };
    return items;
  }

  async resolveAccountItem(
    name: string
  ): Promise<{ item: AccountItem } | { candidates: string[] }> {
    const items = await this.getAccountItems();

    // 完全一致（正規化）
    const exact = items.find((a) => normalizedEquals(a.name, name));
    if (exact) return { item: exact };

    // 前方一致（正規化）
    const prefix = items.filter((a) =>
      toHalfWidth(a.name).toLowerCase().startsWith(toHalfWidth(name).toLowerCase())
    );
    if (prefix.length === 1) return { item: prefix[0] };

    // 部分一致（正規化）
    const partial = items.filter((a) => normalizedIncludes(a.name, name));
    if (partial.length === 1) return { item: partial[0] };

    // 候補を返す
    const candidates = (partial.length > 0 ? partial : items)
      .map((a) => a.name)
      .slice(0, 10);
    return { candidates };
  }

  // ── 取引先 ──

  async getPartners(): Promise<Partner[]> {
    if (this.partners && Date.now() - this.partners.fetchedAt < TTL_MS) {
      return this.partners.data;
    }
    const res = await this.client.get<PartnersResponse>("/api/1/partners", {
      limit: 3000,
    });
    this.partners = { data: res.partners, fetchedAt: Date.now() };
    return res.partners;
  }

  async resolvePartner(
    name: string
  ): Promise<{ partner: Partner } | { candidates: string[] } | null> {
    const partners = await this.getPartners();

    // 完全一致（正規化）
    const exact = partners.find((p) => normalizedEquals(p.name, name));
    if (exact) return { partner: exact };

    // 部分一致（正規化）
    const partial = partners.filter(
      (p) =>
        normalizedIncludes(p.name, name) ||
        normalizedIncludes(name, p.name) ||
        (p.shortcut1 && normalizedIncludes(p.shortcut1, name)) ||
        (p.shortcut2 && normalizedIncludes(p.shortcut2, name))
    );
    if (partial.length === 1) return { partner: partial[0] };
    if (partial.length > 1)
      return { candidates: partial.map((p) => p.name).slice(0, 10) };

    // 見つからない
    return null;
  }

  async createPartner(name: string): Promise<Partner> {
    const res = await this.client.post<{ partner: Partner }>(
      "/api/1/partners",
      { name }
    );
    // キャッシュ無効化
    this.partners = null;
    return res.partner;
  }

  // ── 口座 ──

  async getWalletables(): Promise<Walletable[]> {
    if (this.walletables && Date.now() - this.walletables.fetchedAt < TTL_MS) {
      return this.walletables.data;
    }
    const res = await this.client.get<WalletableResponse>(
      "/api/1/walletables",
      { with_balance: true, with_last_synced_at: true }
    );
    this.walletables = { data: res.walletables, fetchedAt: Date.now() };
    return res.walletables;
  }

  async resolveWalletable(
    name: string
  ): Promise<Walletable | null> {
    const walletables = await this.getWalletables();

    // 完全一致（正規化）
    const exact = walletables.find((w) => normalizedEquals(w.name, name));
    if (exact) return exact;

    // 部分一致（正規化: 半角/全角どちらでもマッチ）
    const partial = walletables.filter((w) => normalizedIncludes(w.name, name));
    if (partial.length === 1) return partial[0];

    return null;
  }

  invalidate(): void {
    this.accountItems = null;
    this.partners = null;
    this.walletables = null;
  }
}
