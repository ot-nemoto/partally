import type { ScheduleItemDto } from "./types.js";

/** 0:00 からの分を「18:05」のように書く（24:00 は「24:00」） */
export function formatMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

/** 「18:00〜18:15」 */
export function formatScheduleRange(item: Pick<ScheduleItemDto, "startMinute" | "durationMinutes">): string {
  return `${formatMinute(item.startMinute)}〜${formatMinute(item.startMinute + item.durationMinutes)}`;
}

/** past: 終わった / now: いま / next: つぎ / none: 強調しない（日付が違う・まだ先） */
export type ScheduleStatus = "past" | "now" | "next" | "none";

/**
 * 参加者の画面で、各項目が「いま」「つぎ」「終わった」のどれかを決める（端末の時計の時刻で判定する）。
 * date（YYYY-MM-DD）があれば、その日だけ判定し、ほかの日はすべて none にする。
 * 「つぎ」は、まだ始まっていない項目のうち最も早く始まるもの（同時に始まるものはすべて）
 */
export function scheduleStatuses(items: ScheduleItemDto[], now: Date, date: string): Map<string, ScheduleStatus> {
  const statuses = new Map<string, ScheduleStatus>(items.map((i) => [i.itemId, "none"]));
  if (date && date !== localDate(now)) return statuses;
  const minute = now.getHours() * 60 + now.getMinutes();
  let nextStart = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const end = item.startMinute + item.durationMinutes;
    if (end <= minute) statuses.set(item.itemId, "past");
    else if (item.startMinute <= minute) statuses.set(item.itemId, "now");
    else nextStart = Math.min(nextStart, item.startMinute);
  }
  for (const item of items) if (item.startMinute === nextStart) statuses.set(item.itemId, "next");
  return statuses;
}

/** 端末の時刻での日付（YYYY-MM-DD） */
export function localDate(now: Date): string {
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${m}-${d}`;
}

/**
 * タイムラインで時間が重なる項目を横に並べるための列。重なり合う項目のまとまりごとに、
 * 開始の早い順に空いている左の列へ入れ、まとまりの列の数で幅を割る
 */
export function scheduleColumns(items: ScheduleItemDto[]): Map<string, { column: number; columns: number }> {
  const result = new Map<string, { column: number; columns: number }>();
  const sorted = [...items].sort((a, b) => a.startMinute - b.startMinute || b.durationMinutes - a.durationMinutes);
  let group: { item: ScheduleItemDto; column: number }[] = [];
  /** 列ごとの、最後に入れた項目の終わり */
  let columnEnds: number[] = [];
  let groupEnd = -1;
  const flush = () => {
    for (const g of group) result.set(g.item.itemId, { column: g.column, columns: columnEnds.length });
    group = [];
    columnEnds = [];
  };
  for (const item of sorted) {
    const end = item.startMinute + item.durationMinutes;
    if (item.startMinute >= groupEnd) flush();
    let column = columnEnds.findIndex((e) => e <= item.startMinute);
    if (column === -1) column = columnEnds.push(end) - 1;
    else columnEnds[column] = end;
    group.push({ item, column });
    groupEnd = Math.max(item.startMinute >= groupEnd ? end : groupEnd, end);
  }
  flush();
  return result;
}
