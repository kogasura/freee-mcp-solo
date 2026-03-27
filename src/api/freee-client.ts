import { TokenManager } from "../auth/token-manager.js";

const BASE_URL = "https://api.freee.co.jp";
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

export class FreeeClient {
  constructor(private tokenManager: TokenManager) {}

  async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const companyId = await this.tokenManager.getCompanyId();
    const url = new URL(`${BASE_URL}${path}`);
    url.searchParams.set("company_id", String(companyId));

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return this.request<T>(url.toString(), { method: "GET" });
  }

  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const companyId = await this.tokenManager.getCompanyId();
    const url = `${BASE_URL}${path}`;

    return this.request<T>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company_id: companyId, ...body }),
    });
  }

  /** 請求書API（/iv/）用のGET。company_idはクエリパラメータで指定 */
  async getInvoice<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const companyId = await this.tokenManager.getCompanyId();
    const url = new URL(`${BASE_URL}/iv${path}`);
    url.searchParams.set("company_id", String(companyId));

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return this.request<T>(url.toString(), { method: "GET" });
  }

  /** 請求書API（/iv/）用のPOST。company_idはクエリパラメータとボディの両方に必要 */
  async postInvoice<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const companyId = await this.tokenManager.getCompanyId();
    const url = new URL(`${BASE_URL}/iv${path}`);
    url.searchParams.set("company_id", String(companyId));

    return this.request<T>(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company_id: companyId, ...body }),
    });
  }

  async delete(path: string): Promise<void> {
    const companyId = await this.tokenManager.getCompanyId();
    const url = new URL(`${BASE_URL}${path}`);
    url.searchParams.set("company_id", String(companyId));

    await this.request<void>(url.toString(), { method: "DELETE" });
  }

  private async request<T>(
    url: string,
    init: RequestInit,
    retryCount = 0
  ): Promise<T> {
    const token = await this.tokenManager.getValidToken();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("User-Agent", "freee-accounting-mcp/0.1.0");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      });

      // 401: トークンリフレッシュして1回だけリトライ
      if (res.status === 401 && retryCount === 0) {
        await this.tokenManager.forceRefresh();
        return this.request<T>(url, init, retryCount + 1);
      }

      // 429: レートリミット時はRetry-Afterに従ってリトライ
      if (res.status === 429 && retryCount < MAX_RETRIES) {
        const retryAfter = parseInt(res.headers.get("Retry-After") ?? "5", 10);
        const waitMs = Math.min(retryAfter * 1000, 30_000);
        await new Promise((r) => setTimeout(r, waitMs));
        return this.request<T>(url, init, retryCount + 1);
      }

      if (!res.ok) {
        const text = await res.text();
        let message: string;
        try {
          const err = JSON.parse(text);
          message =
            err.message ||
            err.errors?.map((e: { message: string }) => e.message).join(", ") ||
            text;
        } catch {
          message = text;
        }
        throw new Error(`freee API エラー (${res.status}): ${message}`);
      }

      if (res.status === 204) {
        return undefined as T;
      }

      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
