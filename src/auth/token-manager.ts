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

/**
 * ディスクのトークンをそのまま使ってよいか。
 *
 * **リフレッシュトークンは1回しか使えない。** 別のプロセス（同じ tokens.json を
 * 使うスクリプトなど）が先に更新していると、メモリにある古いリフレッシュトークン
 * で更新しようとしても 401 になり、MCP が落ちる（2026-09-15 に実際に起きた）。
 * ディスクの方が新しく、まだ十分に有効なら、更新せずにそれを使う。
 */
export function isUsableNewerToken(
  memory: FreeeTokens | null,
  disk: FreeeTokens,
  now: number
): boolean {
  const newer = !memory || disk.expires_at > memory.expires_at;
  return newer && now < disk.expires_at - REFRESH_MARGIN_MS;
}

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

  /**
   * 401 を受けたときの強制リフレッシュ。
   * メモリは失敗したトークンのまま refresh する。doRefresh がディスクと比べ、
   * 別のプロセスが更新済みならそれを使う（先にディスクで上書きすると比べられない）。
   */
  async forceRefresh(): Promise<void> {
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

    // 別のプロセスが先に更新していれば、それを使う
    const disk = await this.readTokensSafely();
    if (isUsableNewerToken(this.tokens, disk, Date.now())) {
      this.tokens = disk;
      return;
    }
    // 更新には最新のリフレッシュトークンを使う（古い方は無効になっている）
    if (!this.tokens || disk.expires_at >= this.tokens.expires_at) {
      this.tokens = disk;
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
      // 同時に別のプロセスが更新した場合は、そちらの結果がディスクにある
      const latest = await this.readTokensSafely();
      if (isUsableNewerToken(this.tokens, latest, Date.now())) {
        this.tokens = latest;
        return;
      }
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

  /**
   * tokens.json を読む。別のプロセスが書き込んでいる最中だと一瞬空になり
   * JSON が壊れて見えるので、少し待って1回だけ読み直す。それでも読めず、
   * メモリにトークンがあればそれを使う（「再認証して」と誤って案内しない）。
   */
  private async readTokensSafely(): Promise<FreeeTokens> {
    try {
      return await readTokens();
    } catch (e) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        return await readTokens();
      } catch {
        if (this.tokens) return this.tokens;
        throw e;
      }
    }
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
