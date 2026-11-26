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
 * - ファイルの列は、使っている列だけで左から詰め直す（サーバは作るたびに空いた列を詰めるので、飛びがあると置いた列がずれる）
 * - 左の列から順に送る（列を左から埋めないと、作るたびに空いた列が詰められて、置いた列がずれる）
 * - 列の数は、サーバが作るたびに行う並べ方（arrangeScheduleColumns。同じ列で時間が重なれば右に列を足して移し、
 *   何もない列は詰める）を、送る順にたどって数える。以前の形式（列の無い項目）や、同じ列で重なる項目があると、
 *   ファイルの列の数より増えるため
 */
export function planScheduleImport(
  current: readonly CurrentItem[],
  file: readonly ScheduleFileItem[],
): ScheduleImportPlan {
  const offset = current.length > 0 ? Math.max(...current.map((i) => i.column)) + 1 : 0;
  const used = [...new Set(file.map((i) => i.column ?? 0))].sort((a, b) => a - b);
  const compact = new Map(used.map((c, i) => [c, i]));
  const items = [...file]
    .sort((a, b) => (a.column ?? 0) - (b.column ?? 0) || a.startMinute - b.startMinute)
    .map((item) => ({ ...item, column: compact.get(item.column ?? 0)! + offset }));

  // 送る順に 1 件ずつ置いて、サーバと同じく並べ直す
  let placed: CurrentItem[] = current.map((i) => ({ ...i }));
  let fits = true;
  let total = offset;
  for (const [n, item] of items.entries()) {
    if (item.column >= SCHEDULE_COLUMNS_MAX) fits = false;
    const itemId = `import-${n}`;
    placed = [
      ...placed,
      { itemId, startMinute: item.startMinute, durationMinutes: item.durationMinutes, column: item.column },
    ];
    const columns = arrangeScheduleColumns(placed, itemId);
    placed = placed.map((i) => ({ ...i, column: columns.get(i.itemId)! }));
    total = Math.max(...placed.map((i) => i.column)) + 1;
    if (total > SCHEDULE_COLUMNS_MAX) fits = false;
  }
  return { items, current: offset, total, fits };
}
