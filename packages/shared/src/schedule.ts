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

type TimedItem = Pick<ScheduleItemDto, "itemId" | "startMinute" | "durationMinutes">;
type PlacedItem = TimedItem & { column?: number; hidden?: boolean };

/**
 * 時間が重なる項目を横に並べる列を、時刻から決める（列を持つ前に作った項目の並べ方）。重なり合う項目のまとまりごとに、
 * 開始の早い順に空いている左の列へ入れ、まとまりの列の数で幅を割る
 */
export function scheduleColumns(items: TimedItem[]): Map<string, { column: number; columns: number }> {
  const result = new Map<string, { column: number; columns: number }>();
  const sorted = [...items].sort((a, b) => a.startMinute - b.startMinute || b.durationMinutes - a.durationMinutes);
  let group: { item: TimedItem; column: number }[] = [];
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

/** 時間が重なるか（終わりと始まりが同じ時刻なら重ならない） */
function overlaps(a: TimedItem, b: TimedItem): boolean {
  return a.startMinute < b.startMinute + b.durationMinutes && b.startMinute < a.startMinute + a.durationMinutes;
}

/**
 * スケジュールの列を決める。項目は幹事が置いた列（column）を持ち、勝手に並べ替えたり動かしたりはしない。
 * - placedId の項目（作った・動かした・長さを変えた項目）が、同じ列のほかの項目と時間が重なったら、
 *   その列のすぐ右に列を足して移す（右側の列は 1 つずつ右へずれる。中の並びは変えない）
 * - 何もない列は詰める（右側の列が 1 つずつ左へずれる）
 * - 列を持たない項目（列を持つ前に作った項目）は、時刻から決めた以前の並べ方の列に置く
 * 項目ごとの列（0 から）を返す
 */
export function arrangeScheduleColumns(items: PlacedItem[], placedId?: string): Map<string, number> {
  const columns = storedColumns(items);
  const placed = placedId === undefined ? undefined : items.find((i) => i.itemId === placedId);
  if (placed) {
    const column = columns.get(placed.itemId)!;
    const hit = items.some(
      (i) => i.itemId !== placed.itemId && columns.get(i.itemId) === column && overlaps(i, placed),
    );
    if (hit) {
      for (const i of items) {
        const c = columns.get(i.itemId)!;
        if (i.itemId !== placed.itemId && c > column) columns.set(i.itemId, c + 1);
      }
      columns.set(placed.itemId, column + 1);
    }
  }
  // 何もない列を詰める（使っている列を、左から 0, 1, 2… に振り直す）
  const used = [...new Set(columns.values())].sort((a, b) => a - b);
  const index = new Map(used.map((c, i) => [c, i]));
  return new Map([...columns].map(([itemId, c]) => [itemId, index.get(c)!]));
}

/** 項目ごとの置いた列（詰める前）。列を持たない項目は、時刻から決めた以前の並べ方の列 */
function storedColumns(items: PlacedItem[]): Map<string, number> {
  const legacy = scheduleColumns(items.filter((i) => i.column === undefined));
  return new Map(items.map((i) => [i.itemId, i.column ?? legacy.get(i.itemId)?.column ?? 0]));
}

/**
 * placedId の項目（作った・動かした項目）を参加者に見せないかを決める。見せるかは列ごとにそろえるので、
 * 置いた列（column。重なりで右へ移す前）にほかの項目があれば、その列に合わせる（1 つでも見せない項目があれば見せない）。
 * ほかの項目が無ければ、その項目の今の値のまま
 */
export function placedScheduleHidden(items: PlacedItem[], placedId: string): boolean {
  const columns = storedColumns(items);
  const placed = items.find((i) => i.itemId === placedId);
  const column = columns.get(placedId);
  const others = items.filter((i) => i.itemId !== placedId && columns.get(i.itemId) === column);
  if (others.length === 0) return placed?.hidden === true;
  return others.some((i) => i.hidden === true);
}

/**
 * 参加者に見せる項目だけにする。見せない列を除き、残った列を左から 0, 1, 2… に詰める
 */
export function visibleSchedule<T extends { column: number; hidden: boolean }>(items: T[]): T[] {
  const visible = items.filter((i) => !i.hidden);
  const used = [...new Set(visible.map((i) => i.column))].sort((a, b) => a - b);
  const index = new Map(used.map((c, i) => [c, i]));
  return visible.map((i) => ({ ...i, column: index.get(i.column)! }));
}
