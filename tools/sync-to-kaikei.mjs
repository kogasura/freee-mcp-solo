#!/usr/bin/env node
//
// freee の1か月分を kaikei へ記帳する。
//
//   node tools/sync-to-kaikei.mjs 2026-09            # 下見（記帳しない）
//   node tools/sync-to-kaikei.mjs 2026-09 --post     # 記帳する
//
// 必要な環境変数:
//   KAIKEI_BIN         kaikei-mcp の実行ファイル
//   APP_DATABASE_URL   kaikei の帳簿（kaikei_app ロール）
//   ほか kaikei-mcp が要求する設定（.env をそのまま読ませる）
//
// ─────────────────────────────────────────────────────────────
// ■ なぜ1本の Node スクリプトなのか
//
// 以前は「取得(node) → 変換(python) → 記帳(node)」と中間ファイルを挟んで
// いた。Windows では Python の標準出力が cp932 になるため、`--emit > file`
// で書いたファイルを Node が UTF-8 として読み、**摘要が129件壊れた**
// （2026-08-13。帳簿を作り直して復旧）。
//
// 中間ファイルと言語をまたぐ経路そのものを無くす。Node は既定で UTF-8。
//
// ■ 変換できないものは黙って通さない
//
// 科目・口座・税区分のどれかが写像に無ければ、その取引で止める。近い科目に
// 寄せると、決算書の内訳や消費税の申告額が黙って変わる。
//
// ■ 記帳の前に必ず突き合わせる
//
// 記帳後に freee の月次サマリーと科目ごとに突き合わせ、1円でも違えば知らせる。

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

// ─── 写像 ────────────────────────────────────────────────────
// freee の科目名 → kaikei の科目コード。**ここに無い科目はエラーにする。**
const ACCOUNT_MAP = {
  売上高: "500",
  受取利息: "530",
  雑収入: "520",
  通信費: "604",
  旅費交通費: "603",
  新聞図書費: "621",
  水道光熱費: "602",
  消耗品費: "609",
  会議費: "623",
  諸会費: "625",
  支払手数料: "620",
  外注費: "613", // kaikei では「外注工賃」（青色申告決算書の科目名）
  接待交際費: "606",
  広告宣伝費: "605",
  租税公課: "600",
  荷造運賃: "601",
  損害保険料: "607",
  // freee 側の科目名は「保険料」。中身は火災保険（事業用）なので損害保険料に
  // 対応させる。**生命保険料ではない**——生命保険料は経費ではなく所得控除。
  保険料: "607",
  修繕費: "608",
  福利厚生費: "611",
  給料賃金: "612",
  利子割引料: "614",
  地代家賃: "615",
  車両費: "624",
  研修費: "622",
  雑費: "690",
  減価償却費: "610",
  // 資産・負債・資本（税区分を付けない）
  事業主貸: "410",
  事業主借: "420",
  未払金: "325",
  売掛金: "135",
  普通預金: "110",
  現金: "100",
};

// freee の口座名 → kaikei の科目コード。
// カードは後払いなので未払金、Suica は前払いの残高なので現金として扱う。
const WALLET_MAP = {
  "ＰａｙＰａｙ銀行（API）": "110",
  三井住友MASTERカード: "325",
  モバイルSuica: "100",
  "freee MasterCard": "325",
};

// freee の税区分コード → kaikei の税区分。
//
// **freee 側の判断をそのまま写す。** 科目から推測して既定を置くと、適格請求書
// の有無（＝仕入税額控除の可否）を勝手に決めることになる。
const TAX_CODE_MAP = {
  129: "SALES_10", // 課税売上10%
  136: "PURCHASE_10_QUALIFIED", // 課対仕入10%（適格）
  189: "PURCHASE_10_NON_QUALIFIED", // 課対仕入（控80）10%
  190: "PURCHASE_10_NON_QUALIFIED", // 課対仕入（控50）10%
  37: "TAX_FREE", // 非課仕入
};

// 税区分を付けない科目（資産・負債・資本）。
const NON_PL_ACCOUNTS = new Set(["410", "420", "325", "135", "110", "100", "400"]);

// freee の取引先名 → kaikei の取引先コード。
//
// **自動生成しない。** 取引先コードは仕訳のタグとして帳簿に残り続け、
// journal_lines は追記型なので後から変えられない。日本語名のローマ字化は
// 一意に決まらない（大久保 = okubo / ohkubo / ookubo）ので、人が決めた対応を
// ここに書く。`list_partners` が出す CSV と揃えること。
//
// 表記ゆれで別登録されているものは同じコードに寄せてある
// （ユーザー確認済み。2026-08-15）。
const PARTNER_MAP = {
  スターパートナーズ合同会社: "star-partners",
  株式会社ＨｏｇＷｏｒｋｓ: "hogworks",
  "株式会社ガリレオ・プロジェクト": "galileo-project",
  ダイパネ工芸株式会社: "daipane",
  JDF株式会社: "jdf",
  三井住友カード: "smcc",
  大久保悠生: "okubo-yuuki",
  グランデ: "grande",
  スターバックス: "starbucks",
  ムームードメイン: "muumuu-domain",
  Microsoft: "microsoft",
  アクア少額短期保険: "aqua-ssi",
  povo: "povo",
  Amazon: "amazon",
  Steam: "steam",
  イオンリテール: "aeon-retail",
  東京電力: "tepco",
  Apple: "apple",
  Google: "google",
  note: "note",
  "LUCID SOFTWARE": "lucid-software",
  OpenAI: "openai",
  "北原 一平": "kitahara",
  キタハラヘイイチ: "kitahara",
  "株式会社 ビーテック": "bitech",
  株式会社ビーテック: "bitech",
  ライフカード: "lifecard",
  GMOペパボ: "gmo-pepabo",
  東急パワーサプライ: "tokyu-power-supply",
  Anthropic: "anthropic",
  "Aqua Voice": "aqua-voice",
  エックスサーバー: "xserver",
  株式会社VISELINK: "viselink",
  株式会社バイスリンク: "viselink",
};

// freee の「対象外」。資産・負債の振替なら正しい。損益科目に付いていても
// freee の判断をそのまま写す（人間が確認済み。2026-08-13）。
const FREEE_OUT_OF_SCOPE = 2;

// ─── MCP クライアント（stdio JSON-RPC）────────────────────────
class McpClient {
  constructor(command, args, env) {
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.child.stdout.on("data", (chunk) => this.#onData(chunk));
    this.child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      // サーバーの起動ログは黙らせるが、それ以外は見せる。
      if (!text.includes("[kaikei-mcp]")) process.stderr.write(text);
    });
  }

  #onData(chunk) {
    this.buffer += chunk.toString();
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim().startsWith("{")) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const resolve = this.pending.get(message.id);
      if (resolve) {
        this.pending.delete(message.id);
        resolve(message);
      }
    }
  }

  #send(object) {
    this.child.stdin.write(JSON.stringify(object) + "\n");
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} が応答しませんでした（60秒）`));
      }, 60_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async initialize(name) {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name, version: "1" },
    });
    this.#send({ jsonrpc: "2.0", method: "notifications/initialized" });
    // サーバーが待受を始めるまで少し待つ。
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  /** ツールを呼ぶ。**失敗を黙って通さない。** */
  async call(name, args) {
    const message = await this.request("tools/call", { name, arguments: args });
    const text = message.result?.content?.[0]?.text ?? "";
    if (message.error || message.result?.isError) {
      throw new Error(`${name} が失敗しました: ${text || JSON.stringify(message.error)}`);
    }
    return text;
  }

  close() {
    this.child.kill();
  }
}

// ─── freee の取引を kaikei の仕訳に変換 ──────────────────────
class Unconvertible extends Error {}

export function toEntry(deal) {
  const code = ACCOUNT_MAP[deal.account];
  if (!code) {
    throw new Unconvertible(`科目「${deal.account}」に対応する kaikei の科目がありません`);
  }
  const walletCode = WALLET_MAP[deal.wallet];
  if (!walletCode) {
    throw new Unconvertible(`口座「${deal.wallet}」に対応する kaikei の科目がありません`);
  }

  const amount = String(deal.amount);
  const isIncome = deal.type === "income";
  // 収入なら口座が増える（借方）、支出なら口座が減る（貸方）。
  const [debitCode, creditCode] = isIncome ? [walletCode, code] : [code, walletCode];

  const lines = [];
  for (const [side, lineCode] of [
    ["debit", debitCode],
    ["credit", creditCode],
  ]) {
    // **freee の取引IDを残す。** これが無いと、再実行したときの重複判定を
    // 「取引日・摘要・明細が同じ」という推測に頼ることになる。同じ内容の
    // 別取引（同じ日に同額の交通費が2件など）と区別できない。
    const line = { account: lineCode, side, amount, tags: { imported_tx_id: String(deal.id) } };
    // **取引先は損益科目かどうかに関わらず付ける。** 誰との取引かは
    // 口座側の明細にも当てはまる。適格請求書の検証（JpTaxPolicy）は
    // 税区分と同じ明細に取引先が要るので、税区分を付ける行には必ず載る。
    if (deal.partner) {
      const counterparty = PARTNER_MAP[deal.partner];
      if (!counterparty) {
        // **黙って落とさない。** 取引先が付かないと、適格請求書が要る
        // 税区分でも相手方を辿れない（kaikei の report/verify が件数を出す）。
        throw new Unconvertible(
          `取引先「${deal.partner}」に対応する kaikei の取引先コードが` +
            `ありません。PARTNER_MAP に追加し、kaikei counterparty import で` +
            `マスタにも登録してください`
        );
      }
      line.tags.counterparty = counterparty;
    }
    if (!NON_PL_ACCOUNTS.has(lineCode)) {
      if (deal.tax_code === FREEE_OUT_OF_SCOPE) {
        line.tags.tax_category = "OUT_OF_SCOPE";
      } else {
        const tax = TAX_CODE_MAP[deal.tax_code];
        if (!tax) {
          throw new Unconvertible(
            `freee の税区分コード ${deal.tax_code} に対応する kaikei の税区分が` +
              `ありません（科目: ${deal.account}）`
          );
        }
        line.tags.tax_category = tax;
      }
    }
    lines.push(line);
  }

  return { entry_date: deal.date, description: deal.description || deal.account, lines };
}

// `list_deals` の1行を解釈する。
// 例: #1 (id:123) 06-15 収入 ¥550,000 売上高 / 摘要 [口座] <tax:129>
const DEAL_LINE =
  /^#\d+ \(id:(?<id>\d+)\) (?<md>\d{2}-\d{2}) (?<kind>収入|支出) ¥(?<amount>[\d,]+) (?<rest>.+) \[(?<wallet>[^\]]+)\] <tax:(?<tax>\d+)>(?: <partner:(?<partner>[^>]*)>)?$/;

export function parseDeals(text, year) {
  const deals = [];
  for (const raw of text.split("\n")) {
    const match = DEAL_LINE.exec(raw.trim());
    if (!match) continue;
    const parts = match.groups.rest.split(" / ");
    deals.push({
      id: match.groups.id,
      date: `${year}-${match.groups.md}`,
      type: match.groups.kind === "収入" ? "income" : "expense",
      amount: Number(match.groups.amount.replace(/,/g, "")),
      account: parts[0],
      description: parts.slice(1).join(" / "),
      wallet: match.groups.wallet,
      tax_code: Number(match.groups.tax),
      partner: match.groups.partner ?? "",
    });
  }
  return deals;
}

/** freee の月次サマリーを科目 → 純額（収入は正、支出は負）に解釈する。 */
function parseMonthlySummary(text) {
  const totals = new Map();
  let sign = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("収入:")) sign = 1;
    else if (line.startsWith("支出:")) sign = -1;
    const match = /^(.+?): ¥([\d,]+) \(\d+件\)$/.exec(line);
    if (match && sign !== 0) {
      const name = match[1].trim();
      const value = Number(match[2].replace(/,/g, "")) * sign;
      totals.set(name, (totals.get(name) ?? 0) + value);
    }
  }
  return totals;
}

function lastDayOf(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 仕訳の指紋。取引日・摘要・明細（科目・貸借・金額）で作る。 */
function fingerprint(entry) {
  // **タグは見ない。** imported_tx_id を付ける前に記帳した仕訳と、付けた後の
  // 仕訳が同じ指紋になる必要がある（そうでないと古い月で二重計上になる）。
  const lines = entry.lines
    .map((line) => `${line.account}/${line.side}/${line.amount}`)
    .sort();
  return `${entry.entry_date}|${entry.description}|${lines.join(",")}`;
}

/**
 * kaikei に既にある仕訳を期間で引き、**取引IDの集合**と**指紋の多重集合**を返す。
 *
 * 取引ID（imported_tx_id）があれば厳密に判定できる。指紋も併用するのは、
 * **このタグを付ける前に記帳した分**が帳簿にあるためである。ID だけで判定すると、
 * 古い月を流し直したときに全件が二重計上になる。
 */
async function existingEntries(kaikei, from, to) {
  const ids = new Set();
  const counts = new Map();
  let cursor;
  for (;;) {
    // search_entries の上限は 100。超えると拒否される。
    const args = { from, to, limit: 100 };
    if (cursor) args.cursor = cursor;
    const page = JSON.parse(await kaikei.call("search_entries", args));
    for (const entry of page.entries ?? []) {
      for (const line of entry.lines ?? []) {
        const id = line.tags?.imported_tx_id;
        if (id) ids.add(String(id));
      }
      const key = fingerprint(entry);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    // **ページングを辿り切る。** 途中で止めると「まだ無い」と誤判定して
    // 二重計上になる。
    cursor = page.next_cursor;
    if (!cursor) break;
  }
  return { ids, counts };
}

// ─── 本体 ────────────────────────────────────────────────────
async function main() {
  const [period, ...flags] = process.argv.slice(2);
  const post = flags.includes("--post");
  // 記帳済みの月を後から検算する（記帳しない）。
  const reconcileOnly = flags.includes("--reconcile");
  if (!/^\d{4}-\d{2}$/.test(period ?? "")) {
    console.error("使い方: node tools/sync-to-kaikei.mjs YYYY-MM [--post|--reconcile]");
    process.exit(2);
  }
  const [year, month] = period.split("-").map(Number);
  const start = `${period}-01`;
  const end = `${period}-${String(lastDayOf(year, month)).padStart(2, "0")}`;

  const kaikeiBin = process.env.KAIKEI_BIN;
  if ((post || reconcileOnly) && !kaikeiBin) {
    console.error("KAIKEI_BIN が未設定です（記帳するには必要です）");
    process.exit(2);
  }

  const freee = new McpClient("node", ["dist/index.js"], process.env);
  await freee.initialize("sync-to-kaikei");

  console.log(`■ freee から取得: ${start} 〜 ${end}`);
  const dealsText = await freee.call("list_deals", {
    start_date: start,
    end_date: end,
    limit: 500,
  });
  const deals = parseDeals(dealsText, year);
  console.log(`  取引 ${deals.length} 件`);

  const transfersText = await freee.call("list_transfers", {
    start_date: start,
    end_date: end,
  });
  const transferCount = (transfersText.match(/^\d{4}-\d{2}-\d{2} ¥/gm) ?? []).length;
  if (transferCount > 0) {
    // 口座振替は取引ではないので list_deals に出てこない。**自動では変換しない**
    // ——どの科目へ振り替えるかは口座の性質で決まる。
    console.log(`  口座振替 ${transferCount} 件（この道具では変換しません。手で記帳してください）`);
    console.log(transfersText.split("\n").filter((l) => l.startsWith("20")).map((l) => "    " + l).join("\n"));
  }

  // 変換
  const entries = [];
  const blocked = [];
  for (const deal of deals) {
    try {
      entries.push(toEntry(deal));
    } catch (error) {
      if (error instanceof Unconvertible) blocked.push({ deal, reason: error.message });
      else throw error;
    }
  }
  console.log(`■ 変換: できた ${entries.length} 件 / できなかった ${blocked.length} 件`);
  if (blocked.length > 0) {
    for (const { deal, reason } of blocked) {
      console.error(`  ${deal.date} ¥${deal.amount.toLocaleString()} ${deal.account}: ${reason}`);
    }
    console.error("変換できない取引があるので中止します（近い科目に寄せることはしません）");
    freee.close();
    process.exit(1);
  }

  // 摘要が壊れていないか（この道具が生まれた原因の再発防止）。
  const broken = entries.filter((entry) => entry.description.includes("�"));
  if (broken.length > 0) {
    console.error(`摘要に置換文字を含む仕訳が ${broken.length} 件あります。文字コードを疑ってください`);
    freee.close();
    process.exit(1);
  }

  if (!post && !reconcileOnly) {
    console.log("■ 下見なので記帳しません（記帳するには --post を付けてください）");
    for (const entry of entries.slice(0, 3)) {
      console.log("  " + JSON.stringify(entry));
    }
    freee.close();
    return;
  }

  // 記帳。**1件でも失敗したら止める**（どこまで入ったかを曖昧にしない）。
  if (post) {
  const kaikei = new McpClient(kaikeiBin, [], process.env);
  await kaikei.initialize("sync-to-kaikei");

  // **既に帳簿にあるものは記帳しない。** 同じ月を2回流しても二重計上に
  // ならないようにする（ROADMAP Phase 4 の完了条件）。
  //
  // 同じ内容の取引が複数あることは普通にある（同じ日に同額の交通費が2件
  // など）ので、**件数で突き合わせる**。freee に3件・帳簿に2件なら1件だけ
  // 記帳する。
  const existing = await existingEntries(kaikei, start, end);
  const fresh = [];
  let alreadyPosted = 0;
  for (const entry of entries) {
    const txId = entry.lines[0]?.tags?.imported_tx_id;
    // 取引IDで一致すれば確実に同じ取引。
    if (txId && existing.ids.has(txId)) {
      alreadyPosted++;
      continue;
    }
    // 取引IDが無い（このタグを付ける前に記帳した）分は指紋で判定する。
    const key = fingerprint(entry);
    const remaining = existing.counts.get(key) ?? 0;
    if (remaining > 0) {
      existing.counts.set(key, remaining - 1);
      alreadyPosted++;
    } else {
      fresh.push(entry);
    }
  }
  if (alreadyPosted > 0) {
    console.log(`■ 既に帳簿にある ${alreadyPosted} 件は記帳しません`);
  }
  if (fresh.length === 0) {
    console.log("■ 記帳するものはありません");
  } else {
    console.log(`■ kaikei へ記帳（${fresh.length} 件）`);
  }
  let posted = 0;
  try {
    for (const entry of fresh) {
      await kaikei.call("post_journal_entry", { ...entry, auto_tax_lines: false });
      posted++;
    }
  } catch (error) {
    console.error(`  ${posted} 件目まで記帳したところで失敗しました: ${error.message}`);
    kaikei.close();
    freee.close();
    process.exit(1);
  }
  console.log(`  ${posted} 件を記帳しました`);
  kaikei.close();
  } else {
    console.log("■ 記帳済みの前提で突き合わせだけ行います（--reconcile）");
  }

  // 突き合わせ。**記帳しただけで終わらせない。**
  //
  // freee の月次サマリーと、**kaikei の帳簿から引いた試算表**を比べる。
  // 取得した取引同士を比べても「記帳できたか」は分からない。
  console.log("■ freee の月次サマリーと kaikei の試算表を突き合わせ");
  const summaryText = await freee.call("monthly_summary", { year, month });
  const freeeTotals = parseMonthlySummary(summaryText);
  freee.close();

  const verifier = new McpClient(kaikeiBin, [], process.env);
  await verifier.initialize("sync-to-kaikei");
  const tbText = await verifier.call("get_trial_balance", { from: start, to: end });
  verifier.close();
  const trialBalance = JSON.parse(tbText);

  // **科目コードで比べる。** 名前で比べると、freee の「保険料」と kaikei の
  // 「損害保険料」が同じ 607 なのに食い違いとして出る（実際に出た）。
  const freeeByCode = new Map();
  const unknownNames = [];
  for (const [name, value] of freeeTotals) {
    const code = ACCOUNT_MAP[name];
    if (!code) {
      unknownNames.push(name);
      continue;
    }
    freeeByCode.set(code, (freeeByCode.get(code) ?? 0) + value);
  }
  // **写像に無い科目を黙って飛ばさない。** freee 側で新しい科目を使い始めた
  // ときに、突き合わせがすり抜けてしまう。
  if (unknownNames.length > 0) {
    console.error(
      `  freee の科目「${unknownNames.join("・")}」が写像にありません。` +
        `ACCOUNT_MAP に足してください`
    );
  }

  // 試算表の残高は科目の自然な向きで返る。freee のサマリーは収入が正・支出が
  // 負なので、資産・費用は符号を反転する。
  const bookByCode = new Map();
  for (const row of trialBalance.rows) {
    const balance = Number(row.balance);
    const signed =
      row.account_type === "asset" || row.account_type === "expense" ? -balance : balance;
    bookByCode.set(row.account, (bookByCode.get(row.account) ?? 0) + signed);
  }

  // **比較の土俵を揃える。** freee の月次サマリーは取引の「科目」側だけを
  // 集計しており、口座側（普通預金・現金・カード）は出てこない。一方 kaikei の
  // 試算表は両側を含む。口座に割り当てた科目をそのまま比べると必ず食い違う
  // （実際に普通預金・現金・未払金で食い違った）。
  //
  // そこで**口座に割り当てた科目は比較から外す**。これらは年次で freee の
  // 貸借対照表（trial_balance ツール）と突き合わせる（kaikei の
  // docs/11-year-end.md）。
  const walletCodes = new Set(Object.values(WALLET_MAP));

  let mismatches = unknownNames.length;
  const codes = new Set([...freeeByCode.keys(), ...bookByCode.keys()]);
  for (const code of [...codes].sort()) {
    if (walletCodes.has(code)) continue;
    const expected = freeeByCode.get(code) ?? 0;
    const actual = bookByCode.get(code) ?? 0;
    if (expected !== actual) {
      console.error(
        `  食い違い 科目${code}: freee ${expected.toLocaleString()} / ` +
          `kaikei ${actual.toLocaleString()}`
      );
      mismatches++;
    }
  }
  console.log(
    `  比較対象外（口座に割り当てた科目 ${[...walletCodes].sort().join("・")}。` +
      `年次で貸借対照表と突き合わせます）`
  );

  if (mismatches > 0) {
    console.error(`突き合わせで ${mismatches} 件の食い違いがあります`);
    process.exit(1);
  }
  console.log("  全科目が一致しました");
}

// **直接実行したときだけ走らせる。** テストから import しただけで同期が
// 動き出す（freee を叩き、--post なら記帳する）のは事故になる。
const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.stack ?? String(error));
    process.exit(1);
  });
}
