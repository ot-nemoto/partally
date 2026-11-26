import { SCHEDULE_COLUMNS_MAX } from "@partally/shared";
import { describe, expect, it } from "vitest";
import { scheduleImportColumns, scheduleImportOffset } from "./scheduleColumns";

const columns = (...cs: number[]) => cs.map((column) => ({ column }));

describe("スケジュールの取り込みの列", () => {
  it("取り込む項目は、今の項目の右の列からずらす（今の項目が無ければ 0 列目から）", () => {
    expect(scheduleImportOffset([])).toBe(0);
    expect(scheduleImportOffset(columns(0, 2, 1, 2))).toBe(3);
  });

  it("今の列と取り込む列を合わせて、上限の列の数までなら取り込める", () => {
    // 今 40 列（0〜39）、ファイルが 10 列（0〜9）で、ちょうど 50 列
    const current = columns(...Array.from({ length: 40 }, (_, i) => i));
    expect(scheduleImportColumns(current, columns(0, 9))).toEqual({
      current: 40,
      imported: 10,
      total: SCHEDULE_COLUMNS_MAX,
      fits: true,
    });
    // 列の無い項目は 0 列目
    expect(scheduleImportColumns([], [{}, { column: 2 }])).toMatchObject({ imported: 3, fits: true });
  });

  it("上限を超えるときは取り込めない", () => {
    // 今 41 列（0〜40）、ファイルが 15 列（0〜14）で、56 列
    const current = columns(...Array.from({ length: 41 }, (_, i) => i));
    expect(scheduleImportColumns(current, columns(0, 14))).toEqual({
      current: 41,
      imported: 15,
      total: 56,
      fits: false,
    });
    // 今の項目が 1 つでもあれば、ファイルが上限いっぱい（50 列）だと超える
    expect(scheduleImportColumns(columns(0), columns(SCHEDULE_COLUMNS_MAX - 1)).fits).toBe(false);
    expect(scheduleImportColumns([], columns(SCHEDULE_COLUMNS_MAX - 1)).fits).toBe(true);
  });
});
