/** yyyy-mm-dd 形式で今日の日付を返す */
export function today(): string {
  return formatDate(new Date());
}

/** N日前の日付を yyyy-mm-dd で返す */
export function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return formatDate(d);
}

/** 指定月の1日を返す */
export function monthStart(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

/** 指定月の末日を返す */
export function monthEnd(year: number, month: number): string {
  const d = new Date(year, month, 0); // month は 1-indexed なので、month=0 日で前月末日
  return formatDate(d);
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 金額をカンマ区切りで表示 */
export function formatYen(amount: number): string {
  const abs = Math.abs(amount);
  const formatted = abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return amount < 0 ? `-¥${formatted}` : `¥${formatted}`;
}
