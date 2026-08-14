# tools/

このリポジトリ本体（freee の MCP サーバー）とは別の、**利用者固有のつなぎ道具**を置く。

## sync-to-kaikei.mjs

freee の1か月分を [kaikei](https://github.com/kogasura/kaikei) の帳簿へ記帳する。

```sh
set -a; . ~/dev/kaikei/.env; set +a
export APP_DATABASE_URL="postgres://.../kaikei_webanana"
export KAIKEI_BIN="$HOME/dev/kaikei/target/debug/kaikei-mcp.exe"

node tools/sync-to-kaikei.mjs 2026-09              # 下見（記帳しない）
node tools/sync-to-kaikei.mjs 2026-09 --post       # 記帳して突き合わせる
node tools/sync-to-kaikei.mjs 2026-07 --reconcile  # 記帳済みの月を後から検算
```

### 何をするか

1. freee から1か月分の取引を取る
2. kaikei の仕訳に変換する（**変換できないものがあれば中止**。近い科目に寄せない）
3. 記帳する（**1件でも失敗したらそこで止める**）
4. freee の月次サマリーと **kaikei の試算表**を科目コードで突き合わせる

### 気をつけていること

- **1本の Node スクリプトにしている。** 以前は「取得(node) → 変換(python) →
  記帳(node)」と中間ファイルを挟んでいたが、Windows では Python の標準出力が
  cp932 になるため、書いたファイルを Node が UTF-8 として読んで**摘要が129件
  壊れた**（2026-08-13。帳簿を作り直して復旧）。言語と中間ファイルをまたぐ
  経路そのものを無くした
- **科目コードで突き合わせる。** 名前で比べると、freee の「保険料」と kaikei の
  「損害保険料」が同じ科目なのに食い違いとして出る
- **口座に割り当てた科目は月次の比較から外す。** freee の月次サマリーは取引の
  「科目」側だけを集計しており、口座側は出てこない。これらは年次で freee の
  貸借対照表と突き合わせる（kaikei の `docs/11-year-end.md`）
- **写像に無い科目を黙って飛ばさない。** freee 側で新しい科目を使い始めたときに
  突き合わせがすり抜けないよう、知らせて食い違いとして数える

### 対象外

**口座振替**（カードの引き落とし等）は freee では取引ではないので取れない。
件数と内容を表示するだけで、変換はしない。どの科目へ振り替えるかは口座の性質で
決まるため、手で記帳すること。

### 置き場所について

kaikei は汎用の OSS なので freee 固有の道具を置かない。この道具は freee と
kaikei をつなぐ利用者固有のものなので、freee 側のリポジトリに置いている。
