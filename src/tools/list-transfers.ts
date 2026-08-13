import { FreeeClient } from "../api/freee-client.js";

/**
 * 口座振替の一覧。
 *
 * freee は口座間の資金移動（カードの引き落とし、銀行間の送金、現金の預け入れ
 * など）を「取引」ではなく**振替**として別に持つ。そのため `list_deals` には
 * 出てこない。
 *
 * 帳簿を他ソフトへ移すときにこれを落とすと、**損益は合うのに残高だけが
 * 合わない**という形で表面化する（借方と貸方に同じ額の差が立つ）。原因の
 * 特定に手間がかかるので、振替は取引と同じように取れるようにしておく。
 */
interface Transfer {
  id: number;
  company_id: number;
  date: string;
  amount: number;
  /** 振替元の口座（walletable）。 */
  from_walletable_type?: string;
  from_walletable_id?: number;
  /** 振替先の口座。 */
  to_walletable_type?: string;
  to_walletable_id?: number;
  description?: string;
}

interface TransfersResponse {
  transfers: Transfer[];
}

interface Walletable {
  id: number;
  name: string;
  type: string;
}

interface WalletablesResponse {
  walletables: Walletable[];
}

interface ListTransfersParams {
  /** 発生日の開始 yyyy-mm-dd。 */
  start_date?: string;
  /** 発生日の終了 yyyy-mm-dd。 */
  end_date?: string;
  /** 取得件数（既定 100、最大 100）。 */
  limit?: number;
}

/**
 * 口座 ID から名前を引くための対応表。
 *
 * 振替の応答は口座を ID でしか持たないので、名前が無いと**どの口座から
 * どの口座へ動いたのかが読めない**。
 */
async function fetchWalletableNames(
  client: FreeeClient
): Promise<Map<string, string>> {
  const res = await client.get<WalletablesResponse>("/api/1/walletables");
  const map = new Map<string, string>();
  for (const w of res.walletables ?? []) {
    map.set(`${w.type}:${w.id}`, w.name);
  }
  return map;
}

export async function listTransfers(
  client: FreeeClient,
  params: ListTransfersParams
): Promise<string> {
  const query = new URLSearchParams();
  if (params.start_date) query.set("start_date", params.start_date);
  if (params.end_date) query.set("end_date", params.end_date);
  query.set("limit", String(Math.min(params.limit ?? 100, 100)));

  const [res, names] = await Promise.all([
    client.get<TransfersResponse>(`/api/1/transfers?${query.toString()}`),
    fetchWalletableNames(client),
  ]);

  const transfers = res.transfers ?? [];
  if (transfers.length === 0) {
    const period =
      params.start_date || params.end_date
        ? `（${params.start_date ?? "指定なし"} 〜 ${params.end_date ?? "指定なし"}）`
        : "";
    return `口座振替はありません${period}。`;
  }

  const label = (type?: string, id?: number): string =>
    names.get(`${type}:${id}`) ?? `${type ?? "?"}:${id ?? "?"}`;

  const lines: string[] = [];
  lines.push(`## 口座振替: ${transfers.length}件`);
  lines.push("");
  let total = 0;
  for (const t of transfers) {
    total += t.amount ?? 0;
    const memo = t.description ? ` / ${t.description}` : "";
    lines.push(
      `${t.date} ¥${(t.amount ?? 0).toLocaleString("ja-JP")} ` +
        `${label(t.from_walletable_type, t.from_walletable_id)} → ` +
        `${label(t.to_walletable_type, t.to_walletable_id)}${memo}`
    );
  }
  lines.push("");
  lines.push(`合計: ¥${total.toLocaleString("ja-JP")}`);

  // **取得上限に当たったことを黙って隠さない。** 件数で切れたまま
  // 「これで全部」と読まれると、移行で振替が落ちる。
  const limit = Math.min(params.limit ?? 100, 100);
  if (transfers.length >= limit) {
    lines.push("");
    lines.push(
      `※ 取得上限 ${limit} 件に達しました。期間を分けて取り直してください` +
        `（この一覧には続きがある可能性があります）。`
    );
  }
  return lines.join("\n");
}
