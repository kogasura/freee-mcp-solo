import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface FreeeConfig {
  clientId: string;
  clientSecret: string;
  callbackPort: number;
  currentCompanyId: string;
  companies: Record<
    string,
    { id: string; name?: string; description?: string }
  >;
}

export interface FreeeTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
  scope: string;
}

const CONFIG_DIR = join(homedir(), ".config", "freee-mcp");

export async function readConfig(): Promise<FreeeConfig> {
  const path = join(CONFIG_DIR, "config.json");
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as FreeeConfig;
  } catch {
    throw new Error(
      "freee-mcp の設定ファイルが見つかりません。先に @him0/freee-mcp で初期認証を完了してください。"
    );
  }
}

export async function readTokens(): Promise<FreeeTokens> {
  const path = join(CONFIG_DIR, "tokens.json");
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as FreeeTokens;
  } catch {
    throw new Error(
      "freee-mcp のトークンファイルが見つかりません。先に @him0/freee-mcp で初期認証を完了してください。"
    );
  }
}

export function getTokensPath(): string {
  return join(CONFIG_DIR, "tokens.json");
}
