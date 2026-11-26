import { SCHEDULE_COLUMNS_MAX } from "@partally/shared";

/**
 * スケジュールの取り込みで、取り込む項目をずらす列の数。取り込む項目は、今の項目の右の列に、ファイルの列の並びのまま置く
 * （今の項目と重ならないように）。置き換えでも、取り込めてから今の項目を消すので、取り込む間は同じく右に置く。
 * 今の項目の列は詰めてある（空いた列はサーバが詰める）ので、今の最大の列 + 1 が今の列の数
 */
export function scheduleImportOffset(current: readonly { column: number }[]): number {
  return current.length > 0 ? Math.max(...current.map((i) => i.column)) + 1 : 0;
}

/**
 * 取り込む間に要る列の数（今の列と、取り込む項目の列を合わせたもの）と、それが上限に収まるか。
 * 上限を超える列には項目を作れない（サーバが断る）ので、収まらないときは何も取り込まずに理由を出す
 */
export function scheduleImportColumns(
  current: readonly { column: number }[],
  items: readonly { column?: number }[],
): { current: number; imported: number; total: number; fits: boolean } {
  const offset = scheduleImportOffset(current);
  const imported = items.length > 0 ? Math.max(...items.map((i) => i.column ?? 0)) + 1 : 0;
  const total = offset + imported;
  return { current: offset, imported, total, fits: total <= SCHEDULE_COLUMNS_MAX };
}
