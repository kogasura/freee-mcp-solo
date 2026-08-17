import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TokenManager } from "./auth/token-manager.js";
import { FreeeClient } from "./api/freee-client.js";
import { MasterCache } from "./cache/master-cache.js";
import { authenticate } from "./tools/authenticate.js";
import { pendingTransactions } from "./tools/pending-transactions.js";
import { createDeal } from "./tools/create-deal.js";
import { monthlySummary } from "./tools/monthly-summary.js";
import { listTaxCodes } from "./tools/list-tax-codes.js";
import { listPartners } from "./tools/list-partners.js";
import { setDealPartner } from "./tools/set-deal-partner.js";
import { setDealAccount } from "./tools/set-deal-account.js";
import { trialBalance } from "./tools/trial-balance.js";
import { listTransfers } from "./tools/list-transfers.js";
import { listFixedAssets } from "./tools/list-fixed-assets.js";
import { unrecordedTransactions } from "./tools/unrecorded-transactions.js";
import { reconcileWallets } from "./tools/reconcile-wallets.js";
import { compareWalletMovements } from "./tools/compare-wallet-movements.js";
import { listDeals } from "./tools/list-deals.js";
import { createInvoice } from "./tools/create-invoice.js";
import { listInvoices } from "./tools/list-invoices.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "freee-mcp-solo",
    version: "0.1.0",
  });

  const tokenManager = new TokenManager();
  const client = new FreeeClient(tokenManager);
  const cache = new MasterCache(client);

  // 共通のエラーハンドリングラッパー
  function wrap(fn: () => Promise<string>) {
    return fn()
      .then((text) => ({
        content: [{ type: "text" as const, text }],
      }))
      .catch((err: unknown) => ({
        content: [
          {
            type: "text" as const,
            text: `エラー: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true as const,
      }));
  }

  // ── authenticate ──
  server.tool(
    "authenticate",
    "OAuth認証の開始・状態確認。初回認証やトークン失効時に使用。",
    {},
    async () => wrap(() => authenticate(tokenManager))
  );

  // ── pending_transactions ──
  server.tool(
    "pending_transactions",
    "未処理（未仕訳）の口座明細一覧を取得する。口座名や期間で絞込可能。",
    {
      wallet_name: z
        .string()
        .optional()
        .describe("口座名で絞込（部分一致）"),
      start_date: z
        .string()
        .optional()
        .describe("開始日 yyyy-mm-dd（デフォルト: 1ヶ月前）"),
      end_date: z
        .string()
        .optional()
        .describe("終了日 yyyy-mm-dd（デフォルト: 今日）"),
      limit: z
        .coerce.number()
        .optional()
        .describe("取得件数（デフォルト: 50, 最大: 100）"),
    },
    async (params) =>
      wrap(() => pendingTransactions(client, cache, params))
  );

  // ── create_deal ──
  server.tool(
    "create_deal",
    "取引（仕訳）を登録する。勘定科目は名前で指定。税区分は勘定科目のデフォルトを自動適用。口座指定で明細と自動紐付け。",
    {
      type: z
        .enum(["income", "expense"])
        .describe("収入(income) or 支出(expense)"),
      issue_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "yyyy-mm-dd形式で指定")
        .describe("発生日 yyyy-mm-dd"),
      amount: z
        .coerce.number()
        .positive("金額は正の数で指定")
        .describe("金額（税込）"),
      account_item: z
        .string()
        .describe("勘定科目名（例: 通信費, 売上高）"),
      wallet_name: z
        .string()
        .optional()
        .describe("決済口座名（例: PayPay銀行）。未指定＝プライベート資金"),
      partner_name: z
        .string()
        .optional()
        .describe("取引先名。未登録の場合は自動作成"),
      description: z
        .string()
        .optional()
        .describe("摘要（備考）"),
    },
    async (params) =>
      wrap(() => createDeal(client, cache, params))
  );

  // ── monthly_summary ──
  server.tool(
    "monthly_summary",
    "月次の収支サマリーを勘定科目別に集計して表示する。",
    {
      year: z
        .coerce.number()
        .optional()
        .describe("年（デフォルト: 今年）"),
      month: z
        .coerce.number()
        .min(1)
        .max(12)
        .optional()
        .describe("月（デフォルト: 今月）"),
    },
    async (params) =>
      wrap(() => monthlySummary(client, cache, params))
  );

  // ── list_deals ──
  server.tool(
    "list_deals",
    "登録済みの取引（仕訳）一覧を取得する。勘定科目名や期間で絞込可能。monthly_summaryの内訳確認や、仕訳の重複チェックに使う。",
    {
      start_date: z
        .string()
        .optional()
        .describe("開始日 yyyy-mm-dd（デフォルト: 1ヶ月前）"),
      end_date: z
        .string()
        .optional()
        .describe("終了日 yyyy-mm-dd（デフォルト: 今日）"),
      account_item: z
        .string()
        .optional()
        .describe("勘定科目名で絞込（例: 支払手数料）"),
      type: z
        .enum(["income", "expense"])
        .optional()
        .describe("収入(income) or 支出(expense)。未指定は両方"),
      limit: z
        .coerce.number()
        .optional()
        .describe("取得件数（デフォルト: 100, 最大: 500）"),
    },
    async (params) =>
      wrap(() => listDeals(client, cache, params))
  );

  // ── set_deal_partner ──
  server.tool(
    "set_deal_partner",
    "既存の取引に取引先を設定する。freee の取引更新は全置換なので、明細と決済はそのまま写す。既定は下見で、commit を付けたときだけ送信する。送信後は取引先以外が変わっていないかを確かめ、変わっていれば以降を中止する。",
    {
      deal_ids: z.string().describe("対象の取引ID（カンマ区切り）"),
      partner_id: z.number().describe("設定する取引先ID"),
      commit: z
        .boolean()
        .optional()
        .describe("実際に送信する（既定: 下見のみ）"),
    },
    async (params) => wrap(() => setDealPartner(client, params))
  );

  // ── set_deal_account ──
  server.tool(
    "set_deal_account",
    "既存の取引の勘定科目を差し替える。取引を消して作り直さない（IDと口座明細の紐付けが変わるため）。freee の取引更新は全置換なので明細と決済はそのまま写す。明細が2件以上ある取引は断る。既定は下見で、commit を付けたときだけ送信する。送信後は科目以外が変わっていないかを確かめる。",
    {
      deal_id: z.coerce.number().describe("対象の取引ID"),
      account_item: z.string().describe("差し替え後の勘定科目名（例: 未払金）"),
      commit: z
        .boolean()
        .optional()
        .describe("実際に送信する（既定: 下見のみ）"),
    },
    async (params) => wrap(() => setDealAccount(client, cache, params))
  );

  // ── compare_wallet_movements ──
  server.tool(
    "compare_wallet_movements",
    "口座の1件ごとの動きを帳簿と明細で突き合わせ、どちらに何件多いかを出す。残高を比べる reconcile_wallets とは別で、残高が合っていても見つかる誤り（二重計上・記帳漏れ）を探す。差が出ても誤りとは限らない（1明細を複数取引に分けた場合など）。",
    {
      start_date: z.string().describe("開始日 YYYY-MM-DD"),
      end_date: z.string().describe("終了日 YYYY-MM-DD"),
      wallet_name: z
        .string()
        .optional()
        .describe("口座名の部分一致で絞る（省略時は全口座）"),
    },
    async (params) => wrap(() => compareWalletMovements(client, cache, params))
  );

  // ── list_partners ──
  server.tool(
    "list_partners",
    "取引先の一覧を取得し、kaikei counterparty import に渡せる CSV を添えて返す。適格請求書発行事業者かどうかは、登録番号が入っているときだけ true とし、それ以外は空欄（未確認）にする。",
    {
      include_unavailable: z
        .boolean()
        .optional()
        .describe("使用停止の取引先も含める（既定: 含めない）"),
    },
    async (params) => wrap(() => listPartners(client, params))
  );

  // ── list_tax_codes ──
  server.tool(
    "list_tax_codes",
    "税区分コードの一覧を取得する。list_deals が返す <tax:136> のようなコードの意味を調べるときや、他ソフトへ仕訳を移すときの写像を作るときに使う。",
    {
      codes: z
        .string()
        .optional()
        .describe("コードで絞込（カンマ区切り。例: 2,136）"),
      keyword: z
        .string()
        .optional()
        .describe("名称の部分一致で絞込（例: 課税仕入）"),
    },
    async (params) => wrap(() => listTaxCodes(client, params))
  );

  // ── trial_balance ──
  server.tool(
    "trial_balance",
    "貸借対照表（試算表）を取得する。科目ごとの期首残高・借方・貸方・期末残高を返す。期首残高は取引として記録されないため list_deals や monthly_summary では取れない。帳簿を他ソフトへ移すときや残高を突き合わせるときに使う。",
    {
      fiscal_year: z
        .number()
        .int()
        .optional()
        .describe("会計年度（例: 2026。省略時は今年）"),
      start_month: z
        .number()
        .int()
        .min(1)
        .max(12)
        .optional()
        .describe("開始月 1-12（省略時は 1）"),
      end_month: z
        .number()
        .int()
        .min(1)
        .max(12)
        .optional()
        .describe("終了月 1-12（省略時は開始月と同じ）"),
      include_zero: z
        .boolean()
        .optional()
        .describe("残高・増減がいずれも 0 の科目も出す（既定: 出さない）"),
    },
    async (params) => wrap(() => trialBalance(client, params))
  );

  // ── list_transfers ──
  server.tool(
    "list_transfers",
    "口座振替の一覧を取得する。カードの引き落とし・口座間送金・現金の預け入れなど、freee が「取引」ではなく「振替」として持つものは list_deals に出てこない。帳簿を他ソフトへ移すときや残高が合わないときに使う。",
    {
      start_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "yyyy-mm-dd形式で指定")
        .optional()
        .describe("発生日の開始 yyyy-mm-dd"),
      end_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "yyyy-mm-dd形式で指定")
        .optional()
        .describe("発生日の終了 yyyy-mm-dd"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("取得件数（デフォルト: 100, 最大: 100）"),
    },
    async (params) => wrap(() => listTransfers(client, params))
  );

  // ── list_fixed_assets ──
  server.tool(
    "list_fixed_assets",
    "固定資産台帳の一覧を取得する。取得年月日・取得価額・耐用年数・償却方法・事業専用割合と、freee が計算した当期償却費を返す。減価償却の計上漏れは決算書を見ても分からない（貸借は一致したまま所得だけが過大になる）ので、決算のときに必ず確かめる。帳簿価額は未償却残高であって取得価額ではない。",
    {
      target_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "yyyy-mm-dd形式で指定")
        .describe("どの時点の台帳か yyyy-mm-dd（必須）"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("取得件数（デフォルト: 100, 最大: 100）"),
    },
    async (params) => wrap(() => listFixedAssets(client, params))
  );

  // ── unrecorded_transactions ──
  server.tool(
    "unrecorded_transactions",
    "口座明細のうち、対応する取引が見当たらないものを挙げる（記帳漏れの疑い）。未処理明細をそのまま見ても記帳漏れは分からない——手で登録した取引は明細と紐付かないので、記帳済みでも未処理明細に残り続ける。取引の側と日付・金額で突き合わせて初めて分かる。月次の締めで使う。挙がるのは「確かめる価値がある明細」であって、記帳漏れと決まったわけではない。",
    {
      start_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "yyyy-mm-dd形式で指定")
        .describe("発生日の開始 yyyy-mm-dd（必須）"),
      end_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "yyyy-mm-dd形式で指定")
        .describe("発生日の終了 yyyy-mm-dd（必須）"),
      wallet_name: z
        .string()
        .optional()
        .describe("口座名で絞込（部分一致）"),
    },
    async (params) => wrap(() => unrecordedTransactions(client, cache, params))
  );

  // ── reconcile_wallets ──
  server.tool(
    "reconcile_wallets",
    "帳簿上の口座残高と、口座の実際の明細を月ごとに突き合わせる。損益は合うのに残高だけ合わない誤り（同じ出金の二重計上など。片方が事業主貸なら損益は変わらないので収支サマリーでは見つからない）を見つける。食い違う月が分かるので、探す範囲を絞れる。期首の食い違いは前年以前の開始残高の問題なので、月々のものと分けて出す。決算前と月次の締めで使う。",
    {
      year: z.number().int().min(2000).max(2100).describe("対象の年（西暦）"),
      wallet_name: z.string().optional().describe("口座名で絞込（部分一致）"),
    },
    async (params) => wrap(() => reconcileWallets(client, cache, params))
  );

  // ── create_invoice ──
  server.tool(
    "create_invoice",
    "請求書を作成する（下書き）。取引先名で指定。入金期日は設定ファイルのルールから自動計算。明細は複数行対応。",
    {
      partner_name: z
        .string()
        .describe("取引先名（例: 株式会社サンプル）"),
      issue_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "yyyy-mm-dd形式で指定")
        .describe("請求日 yyyy-mm-dd"),
      due_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "yyyy-mm-dd形式で指定")
        .optional()
        .describe("入金期日 yyyy-mm-dd（省略時は設定ファイルのルールで自動計算）"),
      subject: z
        .string()
        .optional()
        .describe("件名（省略時は設定ファイルのテンプレートから自動生成）"),
      items: z
        .array(
          z.object({
            description: z.string().describe("品名・摘要"),
            qty: z.coerce.number().describe("数量"),
            unit: z.string().optional().describe("単位（デフォルト: 式）"),
            unit_price: z.coerce.number().describe("単価（税抜）"),
            tax_rate: z.coerce.number().optional().describe("税率（デフォルト: 10。軽減税率は8）"),
          })
        )
        .describe("明細行の配列"),
    },
    async (params) =>
      wrap(() => createInvoice(client, cache, params))
  );

  // ── list_invoices ──
  server.tool(
    "list_invoices",
    "請求書の一覧を取得する。取引先名で絞込可能。",
    {
      partner_name: z
        .string()
        .optional()
        .describe("取引先名で絞込（部分一致）"),
      limit: z
        .coerce.number()
        .optional()
        .describe("取得件数（デフォルト: 10, 最大: 100）"),
    },
    async (params) =>
      wrap(() => listInvoices(client, cache, params))
  );

  return server;
}
