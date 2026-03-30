import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse } from "yaml";

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

const CONFIG_DIR = join(homedir(), ".config", "freee-mcp-solo");

interface YamlConfig {
  auth?: {
    client_id?: string;
    client_secret?: string;
    callback_port?: number;
    company_id?: string;
    company_name?: string;
  };
}

export async function readConfig(): Promise<FreeeConfig> {
  const configPath = join(CONFIG_DIR, "config.yaml");
  try {
    const raw = await readFile(configPath, "utf-8");
    const yaml = parse(raw) as YamlConfig;

    if (!yaml.auth?.client_id || !yaml.auth?.client_secret) {
      throw new Error(
        "認証情報が設定されていません。\n" +
          "~/.config/freee-mcp-solo/config.yaml の auth セクションに client_id と client_secret を設定してください。\n\n" +
          "freee アプリの作成方法:\n" +
          "  1. https://app.secure.freee.co.jp/developers にアクセス\n" +
          "  2. 「新しいアプリを作成」→ アプリ名を入力\n" +
          "  3. コールバックURL に http://127.0.0.1:54321/callback を設定\n" +
          "  4. 取得した client_id と client_secret を config.yaml に記入"
      );
    }

    const companyId = yaml.auth.company_id ?? "";
    const companies: FreeeConfig["companies"] = {};
    if (companyId) {
      companies[companyId] = {
        id: companyId,
        name: yaml.auth.company_name,
      };
    }

    return {
      clientId: yaml.auth.client_id,
      clientSecret: yaml.auth.client_secret,
      callbackPort: yaml.auth.callback_port ?? 54321,
      currentCompanyId: companyId,
      companies,
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes("認証情報が設定されていません")) {
      throw err;
    }
    throw new Error(
      "設定ファイルが見つかりません。\n" +
        "~/.config/freee-mcp-solo/config.yaml を作成してください。\n" +
        "テンプレート: config.example.yaml を参照"
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
      "トークンが見つかりません。authenticate ツールで認証を実行してください。"
    );
  }
}

export function getTokensPath(): string {
  return join(CONFIG_DIR, "tokens.json");
}
