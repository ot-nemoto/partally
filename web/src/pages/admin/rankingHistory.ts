/**
 * time の時点の累計。登録前なら undefined。
 * 時刻は API の文字列のままでも、何度も呼ぶときのために先に数にしたものでもよい
 */
export function valueAt(history: { at: string | number; points: number }[], time: number) {
  let value: number | undefined;
  for (const h of history) {
    if ((typeof h.at === "number" ? h.at : Date.parse(h.at)) > time) break;
    value = h.points;
  }
  return value;
}

/** 表示する期間がこれより長いと、時刻に日付も付ける */
export function needsDate(span: number) {
  return span > 20 * 60 * 60 * 1000;
}

/** 時刻を「21:05」の形にする。withDate なら「12/20 21:05」 */
export function formatTime(time: number, withDate: boolean) {
  const d = new Date(time);
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  return withDate ? `${d.getMonth() + 1}/${d.getDate()} ${hm}` : hm;
}
