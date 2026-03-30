import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import type { FreeeConfig } from "../auth/config-reader.js";
import { TokenManager } from "../auth/token-manager.js";

const AUTH_ENDPOINT =
  "https://accounts.secure.freee.co.jp/public_api/authorize";
const TOKEN_ENDPOINT =
  "https://accounts.secure.freee.co.jp/public_api/token";
const AUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5分
const CONFIG_PATH = join(homedir(), ".config", "freee-mcp-solo", "config.yaml");

export async function authenticate(
  tokenManager: TokenManager
): Promise<string> {
  // ディスクからトークンを再読み込み（別プロセスで更新された場合に対応）
  await tokenManager.reloadTokens();

  const expiry = await tokenManager.getTokenExpiryInfo();
  if (expiry.valid && expiry.remainingMin > 5) {
    const name = await tokenManager.getCompanyName();
    return `認証済みです。\nユーザー事業所: ${name}\nトークン残り: ${expiry.remainingMin}分`;
  }

  // トークンリフレッシュを試みる
  try {
    await tokenManager.forceRefresh();
    const name = await tokenManager.getCompanyName();
    return `トークンをリフレッシュしました。\n事業所: ${name}`;
  } catch {
    // リフレッシュ失敗 → OAuth認証フローを開始
  }

  const config = await tokenManager.getConfig();
  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = randomBytes(16).toString("hex");

  const redirectUri = `http://127.0.0.1:${config.callbackPort}/callback`;
  const authUrl = new URL(AUTH_ENDPOINT);
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "read write");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  // コールバックサーバーをバックグラウンドで起動し、先にURLを返す
  startCallbackServer(config, state, codeVerifier, redirectUri, tokenManager);

  return `以下のURLをブラウザで開いてfreeeにログインしてください:\n${authUrl.toString()}\n\n認証完了後、自動的にトークンが保存されます（タイムアウト: 5分）。\n完了したら再度 authenticate を呼んで状態を確認してください。`;
}

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32)
    .toString("base64url")
    .replace(/[^a-zA-Z0-9\-._~]/g, "");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

/** 認証完了後に事業所情報を取得して config.yaml に保存する */
async function saveCompanyInfo(accessToken: string): Promise<void> {
  try {
    const res = await fetch("https://api.freee.co.jp/api/1/users/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return;

    const data = (await res.json()) as {
      user: {
        companies: Array<{
          id: number;
          display_name: string;
          role: string;
        }>;
      };
    };

    const companies = data.user.companies;
    if (companies.length === 0) return;

    // 最初の事業所を使用
    const company = companies[0];

    // config.yaml を読み込んで auth.company_id と auth.company_name を更新
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const yaml = parse(raw) as Record<string, unknown>;

    const auth = (yaml.auth ?? {}) as Record<string, unknown>;
    auth.company_id = String(company.id);
    auth.company_name = company.display_name;
    yaml.auth = auth;

    await writeFile(CONFIG_PATH, stringify(yaml, { lineWidth: 0 }), { mode: 0o600 });
  } catch {
    // 事業所情報の保存に失敗しても認証自体は完了しているので無視
  }
}

function startCallbackServer(
  config: FreeeConfig,
  expectedState: string,
  codeVerifier: string,
  redirectUri: string,
  tokenManager: TokenManager
): void {
  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (state !== expectedState || !code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<html><body><h1>認証エラー</h1><p>不正なリクエストです。再度お試しください。</p></body></html>");
        clearTimeout(timeout);
        server.close();
        return;
      }

      try {
        // トークン交換
        const tokenRes = await fetch(TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code_verifier: codeVerifier,
          }),
        });

        if (!tokenRes.ok) {
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<html><body><h1>トークン取得エラー</h1></body></html>");
          return;
        }

        const data = (await tokenRes.json()) as {
          access_token: string;
          refresh_token: string;
          expires_in: number;
          token_type: string;
          scope: string;
        };

        await tokenManager.saveTokens({
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_at: Date.now() + data.expires_in * 1000,
          token_type: data.token_type,
          scope: data.scope,
        });

        // 事業所情報を自動取得して config.yaml に保存
        await saveCompanyInfo(data.access_token);

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<html><body><h1>認証完了</h1><p>このウィンドウを閉じてください。</p></body></html>"
        );
      } finally {
        clearTimeout(timeout);
        server.close();
      }
    }
  );

  const timeout = setTimeout(() => {
    server.close();
  }, AUTH_TIMEOUT_MS);

  server.listen(config.callbackPort, "127.0.0.1");
}
