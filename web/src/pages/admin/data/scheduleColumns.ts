import { arrangeScheduleColumns, SCHEDULE_COLUMNS_MAX } from "@partally/shared";
import type { ScheduleFileItem } from "@partally/shared/schedule-file";

/** 今の項目（列を決めるのに要るところだけ） */
type CurrentItem = { itemId: string; startMinute: number; durationMinutes: number; column: number };

export interface ScheduleImportPlan {
  /** 送る順の項目と、送る列（今の列の右にずらしたもの） */
  items: (ScheduleFileItem & { column: number })[];
  /** 今の列の数 */
  current: number;
  /** 取り込み終えたときの列の数（今の列を含む） */
  total: number;
  /** 上限の列の数に収まるか。収まらないと、途中で作れなくなる（送る列が上限を超えると、サーバが断る） */
  fits: boolean;
}

/**
 * スケジュールの取り込みで、項目を送る順と列を決め、取り込み終えたときの列の数を数える。
 * - 取り込む項目は、今の項目の右の列に、ファイルの列の並びのまま置く（今の項目と重ならないように）。置き換えでも、
 *   取り込めてから今の項目を消すので、取り込む間は同じく右に置く
 * - ファイルの列ごとに、左の列から順に送る。列の最初の項目は、その時点の右端の新しい列に送り、続く項目はその列に送る
 *   （ファイルの列に飛びがあっても、使っている列だけで左から並ぶ）
 * - サーバは作るたびに列を並べ直す（arrangeScheduleColumns。同じ列で時間が重なれば右に列を足して移し、何もない列は
 *   詰める）。送る順にそれと同じ並べ方をたどり、ファイルの列の今の位置と、取り込み終えたときの列の数を数える。
 *   以前の形式（列の無い項目）や、同じ列で重なる項目があると、ファイルの列の数より増える。重なりで右に移った項目の
 *   列には、ファイルの次の列の項目を入れない（その時点の右端の新しい列に送る）
 */
export function planScheduleImport(
  current: readonly CurrentItem[],
  file: readonly ScheduleFileItem[],
): ScheduleImportPlan {
  const ordered = [...file].sort((a, b) => (a.column ?? 0) - (b.column ?? 0) || a.startMinute - b.startMinute);
  let placed: CurrentItem[] = current.map((i) => ({ ...i }));
  const columnCount = () => (placed.length > 0 ? Math.max(...placed.map((i) => i.column)) + 1 : 0);
  const offset = columnCount();
  const items: ScheduleImportPlan["items"] = [];
  let fits = true;
  /** 送っているファイルの列と、その列の最初の項目（重なりで右に移らないので、その列の今の位置の目印になる） */
  let group: { fileColumn: number; firstId: string } | undefined;
  for (const [n, item] of ordered.entries()) {
    const itemId = `import-${n}`;
    const fileColumn = item.column ?? 0;
    const sameGroup = group?.fileColumn === fileColumn;
    const column = sameGroup ? placed.find((i) => i.itemId === group!.firstId)!.column : columnCount();
    if (!sameGroup) group = { fileColumn, firstId: itemId };
    if (column >= SCHEDULE_COLUMNS_MAX) fits = false;
    items.push({ ...item, column });
    placed = [...placed, { itemId, startMinute: item.startMinute, durationMinutes: item.durationMinutes, column }];
    const columns = arrangeScheduleColumns(placed, itemId);
    placed = placed.map((i) => ({ ...i, column: columns.get(i.itemId)! }));
  }
  const total = columnCount();
  if (total > SCHEDULE_COLUMNS_MAX) fits = false;
  return { items, current: offset, total, fits };
}
