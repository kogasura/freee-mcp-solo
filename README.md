# freee-mcp-solo

個人事業主・フリーランスの日常経理に特化した [freee会計](https://www.freee.co.jp/) 用 MCP (Model Context Protocol) サーバー。

Claude Code や Claude Desktop から、仕訳登録・請求書作成・月次確認をシンプルなツール呼び出しで実行できます。

## 特徴

- **ユースケース駆動** — freee API の 1:1 ラッパーではなく、「仕訳」「請求書作成」「月次確認」という実際の業務に最適化
- **名前ベースの操作** — 勘定科目・取引先・口座を名前で指定。ID への変換はサーバーが自動処理
- **設定ファイルで柔軟に** — 振込先、入金期日ルール、件名テンプレートを YAML で管理
- **全角/半角を自動正規化** — 「PayPay銀行」で「ＰａｙＰａｙ銀行（API）」にマッチ

## ツール一覧

| ツール | 用途 |
|---|---|
| `authenticate` | OAuth認証・状態確認 |
| `pending_transactions` | 未処理（未仕訳）の口座明細を一覧表示 |
| `create_deal` | 取引（仕訳）を登録 |
| `monthly_summary` | 月次の収支を勘定科目別に集計 |
| `create_invoice` | 請求書を作成（下書き） |
| `list_invoices` | 請求書の一覧を表示 |

## 前提条件

- Node.js 20 以上
- freee 会計アカウント（個人事業主プラン以上）
- [@him0/freee-mcp](https://github.com/him0/freee-mcp) で初期認証が完了していること

> 本サーバーは `@him0/freee-mcp` の認証情報（`~/.config/freee-mcp/`）を再利用します。初回のみ `@him0/freee-mcp` で OAuth 認証を完了してください。

## セットアップ

### 1. インストール

```bash
npm install -g freee-mcp-solo
```

または、ソースからビルド:

```bash
git clone https://github.com/kogasura/freee-mcp-solo.git
cd freee-mcp-solo
npm install
npm run build
```

### 2. 初期認証（@him0/freee-mcp を使用）

```bash
npx @him0/freee-mcp
```

ブラウザで freee にログインし、OAuth 認証を完了してください。

### 3. 設定ファイルの作成

```bash
mkdir -p ~/.config/freee-mcp-solo
cp config.example.yaml ~/.config/freee-mcp-solo/config.yaml
```

`config.yaml` を環境に合わせて編集:

```yaml
# 振込先情報（請求書に記載）
payment:
  bank_info: "○○銀行 △△支店 普通 1234567 カ）サンプル"

# 請求書のデフォルト設定
invoice:
  tax_entry_method: exclusive  # exclusive(外税) / inclusive(内税)
  default_account_item: "売上高"
  layout: default_classic
  message: "下記の通りご請求申し上げます。"

# 取引先ごとの設定
partners:
  株式会社サンプル:
    due_date_rule: "+1month_end"     # 翌月末
    partner_title: "御中"
    subject_template: "開発費_{YY}年{MM}月"
```

#### 入金期日ルール (`due_date_rule`)

| ルール | 意味 |
|---|---|
| `+1month_end` | 翌月末日 |
| `+2months_15` | 翌々月15日 |
| `+1month_20` | 翌月20日 |
| `+30days` | 30日後 |

#### 件名テンプレート (`subject_template`)

| 変数 | 展開結果 |
|---|---|
| `{YYYY}` | 4桁の年（例: 2026） |
| `{YY}` | 2桁の年（例: 26） |
| `{MM}` | 2桁の月（例: 03） |
| `{M}` | 月（例: 3） |

### 4. Claude Code / Claude Desktop に登録

`.mcp.json` に以下を追加:

```json
{
  "mcpServers": {
    "freee-solo": {
      "type": "stdio",
      "command": "freee-mcp-solo"
    }
  }
}
```

ソースからビルドした場合:

```json
{
  "mcpServers": {
    "freee-solo": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/freee-mcp-solo/dist/index.js"]
    }
  }
}
```

Claude Desktop の場合は `claude_desktop_config.json` に同様の設定を追加:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

## 使い方

### 仕訳作業

```
ユーザー: 未処理の明細を仕訳して

Claude: pending_transactions() を実行
→ 未処理明細 5件:
  #1 03/25 出金 ¥1,100 さくらインターネット
  #2 03/25 出金 ¥2,200 ANTHROPIC
  ...

Claude: 以下の仕訳でよいですか？
  #1 通信費 / さくらインターネット / レンタルサーバー
  #2 通信費 / Anthropic / Claude Pro
  ...

ユーザー: ok

Claude: create_deal() x 5 を実行 → 全件登録完了
```

### 請求書作成

```
ユーザー: 今月の請求書を30万で作って

Claude: create_invoice(
  partner_name: "株式会社サンプル",
  issue_date: "2026-03-31",
  items: [{ description: "開発費_26年03月", qty: 1, unit_price: 300000 }]
)
→ 請求書を作成しました (ID: 12345)
  請求番号: INV-0000000001
  金額: ¥300,000（税抜） / ¥330,000（税込）
  入金期日: 2026-04-30（自動計算）
```

### 月次確認

```
ユーザー: 今月の収支は？

Claude: monthly_summary()
→ 2026年3月 収支サマリー
  収入: ¥990,000
  支出: ¥234,567
  差引利益: ¥755,433
```

## 使用する freee API

| API | エンドポイント | 用途 |
|---|---|---|
| 会計 API | `https://api.freee.co.jp/api/1/` | 仕訳・口座明細・マスタデータ |
| 請求書 API | `https://api.freee.co.jp/iv/` | 請求書の作成・一覧 |

## ライセンス

MIT
