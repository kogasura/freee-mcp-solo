import { writeFile } from "node:fs/promises";
import {
  readConfig,
  readTokens,
  getTokensPath,
  type FreeeConfig,
  type FreeeTokens,
} from "./config-reader.js";

const TOKEN_ENDPOINT = "https://accounts.secure.freee.co.jp/public_api/token";
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // 5分前にリフレッシュ

export class TokenManager {
  private config: FreeeConfig | null = null;
  private tokens: FreeeTokens | null = null;
  private refreshPromise: Promise<void> | null = null;

  async getConfig(): Promise<FreeeConfig> {
    if (!this.config) {
      this.config = await readConfig();
    }
    return this.config;
  }

  async getCompanyId(): Promise<number> {
    const config = await this.getConfig();
    const id = parseInt(config.currentCompanyId, 10);
    if (isNaN(id)) {
      throw new Error(
        `事業所IDが不正です: ${config.currentCompanyId}`
      );
    }
    return id;
  }

  async getCompanyName(): Promise<string> {
    const config = await this.getConfig();
    const company = config.companies[config.currentCompanyId];
    return company?.name ?? "不明";
  }

  async getValidToken(): Promise<string> {
    if (!this.tokens) {
      this.tokens = await readTokens();
    }

    if (Date.now() < this.tokens.expires_at - REFRESH_MARGIN_MS) {
      return this.tokens.access_token;
    }

    // リフレッシュ（競合防止）
    await this.refresh();
    return this.tokens!.access_token;
  }

  /** 外部から強制リフレッシュを実行する（ディスクから再読み込み後リフレッシュ） */
  async forceRefresh(): Promise<void> {
    this.tokens = await readTokens();
    await this.refresh();
  }

  /** authenticate ツールからトークンを直接保存する */
  async saveTokens(tokens: FreeeTokens): Promise<void> {
    this.tokens = tokens;
    await writeFile(getTokensPath(), JSON.stringify(tokens, null, 2), { mode: 0o600 });
  }

  /** ディスクからトークンを再読み込みする（別プロセスで更新された場合用） */
  async reloadTokens(): Promise<void> {
    this.tokens = await readTokens();
  }

  private async refresh(): Promise<void> {
    // 並行リフレッシュ防止
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async doRefresh(): Promise<void> {
    const config = await this.getConfig();
    if (!this.tokens) {
      this.tokens = await readTokens();
    }

    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.tokens.refresh_token,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });

    if (!res.ok) {
      throw new Error(
        `トークンリフレッシュに失敗しました (${res.status})。authenticate ツールで再認証してください。`
      );
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      token_type: string;
      scope: string;
    };

    this.tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
      token_type: data.token_type,
      scope: data.scope,
    };

    await writeFile(getTokensPath(), JSON.stringify(this.tokens, null, 2), { mode: 0o600 });
  }

  async getTokenExpiryInfo(): Promise<{ valid: boolean; remainingMin: number }> {
    try {
      if (!this.tokens) {
        this.tokens = await readTokens();
      }
      const remaining = this.tokens.expires_at - Date.now();
      return {
        valid: remaining > 0,
        remainingMin: Math.floor(remaining / 60000),
      };
    } catch {
      return { valid: false, remainingMin: 0 };
    }
  }
}
