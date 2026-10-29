import type { RankingPointDto } from "@partally/shared";

/** time の時点の累計。登録前なら undefined */
export function valueAt(history: RankingPointDto[], time: number) {
  let value: number | undefined;
  for (const h of history) {
    if (Date.parse(h.at) > time) break;
    value = h.points;
  }
  return value;
}

/** 時刻を「21:05」の形にする。withDate なら「12/20 21:05」 */
export function formatTime(time: number, withDate: boolean) {
  const d = new Date(time);
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  return withDate ? `${d.getMonth() + 1}/${d.getDate()} ${hm}` : hm;
}
