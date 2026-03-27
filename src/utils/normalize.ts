/** 全角英数字・記号を半角に変換する */
export function toHalfWidth(str: string): string {
  return str
    .replace(/[\uff01-\uff5e]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    )
    .replace(/\u3000/g, " "); // 全角スペース → 半角スペース
}

/** 半角英数字・記号を全角に変換する */
export function toFullWidth(str: string): string {
  return str
    .replace(/[!-~]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) + 0xfee0)
    )
    .replace(/ /g, "\u3000"); // 半角スペース → 全角スペース
}

/** 正規化して比較する（全角/半角を統一して部分一致） */
export function normalizedIncludes(haystack: string, needle: string): boolean {
  const h = toHalfWidth(haystack).toLowerCase();
  const n = toHalfWidth(needle).toLowerCase();
  return h.includes(n);
}

/** 正規化して完全一致 */
export function normalizedEquals(a: string, b: string): boolean {
  return toHalfWidth(a).toLowerCase() === toHalfWidth(b).toLowerCase();
}
