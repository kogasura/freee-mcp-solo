import { FreeeClient } from "../api/freee-client.js";

/**
 * 固定資産台帳の一覧。
 *
 * # なぜ要るのか
 *
 * **減価償却の計上漏れは決算書を見ても分からない。** 貸借は一致したままで、
 * 所得だけが過大になる。翌年に気づいても、その年分は申告済みである。
 *
 * 償却額を出すには取得年月日・取得価額・耐用年数・償却方法・事業専用割合が
 * 要るが、これらは仕訳には現れない（貸借対照表に載るのは未償却残高だけ）。
 * 台帳を引けないと、毎年これを人に聞くことになる。
 *
 * # 金額の意味を取り違えない
 *
 * `book_value`（帳簿価額）は**未償却残高**であって取得価額ではない。両者を
 * 混ぜると、償却が進んだ資産ほど償却費を過小に計算する。
 */
interface FixedAsset {
  id: number;
  company_id: number;
  /** 資産の名前。 */
  name: string;
  /** 取得年月日 yyyy-mm-dd。 */
  acquisition_date?: string;
  /** 取得価額。**未償却残高ではない。** */
  acquisition_cost?: number;
  /** 期首（または取得時）の帳簿価額。 */
  book_value?: number;
  /** 耐用年数（年）。 */
  service_life?: number;
  /** 償却方法（`straight_line` = 定額法 など、freee の語彙のまま）。 */
  depreciation_method?: string;
  /** 償却率。 */
  depreciation_rate?: number;
  /** 事業専用割合（%）。家事按分が要る資産で1未満になる。 */
  business_use_percentage?: number;
  /** 対応する勘定科目のID。 */
  account_item_id?: number;
  /** 当期の償却費（freee が計算した額）。 */
  depreciation_amount?: number;
  /** 除却・売却した日。 */
  retirement_date?: string;
}

interface FixedAssetsResponse {
  fixed_assets: FixedAsset[];
}

interface AccountItem {
  id: number;
  name: string;
}

interface AccountItemsResponse {
  account_items: AccountItem[];
}

interface ListFixedAssetsParams {
  /** どの時点の台帳か yyyy-mm-dd。**必須**（freee API が要求する）。 */
  target_date: string;
  /** 取得件数（既定 100、最大 100）。 */
  limit?: number;
}

/**
 * 勘定科目 ID から名前を引くための対応表。
 *
 * 台帳の応答は科目を ID でしか持たないので、名前が無いとどの科目の資産か
 * 読めない。
 */
async function fetchAccountItemNames(
  client: FreeeClient
): Promise<Map<number, string>> {
  const res = await client.get<AccountItemsResponse>("/api/1/account_items");
  const names = new Map<number, string>();
  for (const item of res.account_items ?? []) {
    names.set(item.id, item.name);
  }
  return names;
}

/** 償却方法を日本語にする。**知らない値は書き換えず、そのまま出す。** */
function methodLabel(method?: string): string {
  switch (method) {
    case "straight_line":
      return "定額法";
    case "declining_balance":
      return "定率法";
    case "lump_sum":
      return "一括償却";
    case "small_amount":
      return "少額減価償却資産";
    case undefined:
      return "（不明）";
    default:
      return method;
  }
}

export async function listFixedAssets(
  client: FreeeClient,
  params: ListFixedAssetsParams
): Promise<string> {
  const limit = Math.min(params.limit ?? 100, 100);
  const res = await client.get<FixedAssetsResponse>("/api/1/fixed_assets", {
    target_date: params.target_date,
    limit,
  });
  const assets = res.fixed_assets ?? [];

  if (assets.length === 0) {
    // **0件は「台帳が空」であって「取れなかった」ではない。**
    return (
      `## 固定資産台帳: 0件（${params.target_date} 時点）\n\n` +
      `この時点で登録されている固定資産はありません。\n` +
      `貸借対照表に固定資産の残高があるのに0件の場合、台帳に登録せず` +
      `仕訳だけで資産計上している可能性があります（その場合、freee は` +
      `償却費を計算しません）。`
    );
  }

  const accountNames = await fetchAccountItemNames(client);
  const lines: string[] = [
    `## 固定資産台帳: ${assets.length}件（${params.target_date} 時点）`,
    "",
  ];

  let totalDepreciation = 0;
  for (const asset of assets) {
    const account = asset.account_item_id
      ? (accountNames.get(asset.account_item_id) ?? `科目ID:${asset.account_item_id}`)
      : "（科目未設定）";
    lines.push(`### ${asset.name} [${account}]`);
    lines.push(`- 取得年月日: ${asset.acquisition_date ?? "（不明）"}`);
    // **取得価額と未償却残高を並べて出す。** 混ぜると、償却が進んだ資産ほど
    // 償却費を過小に計算する。
    lines.push(
      `- 取得価額: ${yen(asset.acquisition_cost)}` +
        `　/　帳簿価額（未償却残高）: ${yen(asset.book_value)}`
    );
    lines.push(
      `- 耐用年数: ${asset.service_life ?? "（不明）"}年` +
        `　/　償却方法: ${methodLabel(asset.depreciation_method)}` +
        `　/　償却率: ${asset.depreciation_rate ?? "（不明）"}`
    );
    if (asset.business_use_percentage !== undefined) {
      lines.push(`- 事業専用割合: ${asset.business_use_percentage}%`);
    }
    if (asset.depreciation_amount !== undefined) {
      totalDepreciation += asset.depreciation_amount;
      lines.push(`- 当期償却費（freee の計算）: ${yen(asset.depreciation_amount)}`);
    }
    if (asset.retirement_date) {
      lines.push(`- 除却・売却: ${asset.retirement_date}`);
    }
    lines.push("");
  }

  if (totalDepreciation > 0) {
    lines.push(`当期償却費の合計: ${yen(totalDepreciation)}`);
    lines.push("");
  }
  lines.push(
    "※ 償却費は freee が台帳から計算した額です。事業専用割合や " +
      "少額減価償却資産の特例の適用可否は、内容に応じて確かめてください。"
  );

  // **取得上限に当たったことを黙って隠さない。** 件数で切れたまま
  // 「これで全部」と読まれると、償却費が丸ごと落ちる。
  if (assets.length >= limit) {
    lines.push("");
    lines.push(
      `※ 取得上限 ${limit} 件に達しました。この一覧には続きがある可能性があります。`
    );
  }
  return lines.join("\n");
}

/** 金額を表示用にする。**無いことを 0 円と書かない。** */
function yen(amount?: number): string {
  if (amount === undefined || amount === null) {
    return "（不明）";
  }
  return `¥${amount.toLocaleString("ja-JP")}`;
}
