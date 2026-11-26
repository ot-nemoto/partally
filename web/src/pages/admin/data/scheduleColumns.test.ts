import { SCHEDULE_COLUMNS_MAX } from "@partally/shared";
import type { ScheduleFileItem } from "@partally/shared/schedule-file";
import { describe, expect, it } from "vitest";
import { planScheduleImport } from "./scheduleColumns";

/** 今の項目（列ごとに 1 件。同じ時刻） */
const currentColumns = (count: number) =>
  Array.from({ length: count }, (_, column) => ({
    itemId: `now-${column}`,
    startMinute: 600,
    durationMinutes: 30,
    column,
  }));
/** ファイルの項目（列ごとに 1 件。同じ時刻） */
const fileItem = (column: number | undefined, startMinute = 600): ScheduleFileItem => ({
  title: `項目 ${column}`,
  detail: "",
  startMinute,
  durationMinutes: 30,
  ...(column === undefined ? {} : { column }),
});

describe("スケジュールの取り込みの列", () => {
  it("取り込む項目は、今の項目の右の列に、ファイルの列の並びのまま左の列から送る", () => {
    const plan = planScheduleImport(currentColumns(3), [fileItem(1, 700), fileItem(0, 660), fileItem(0, 600)]);
    expect(plan.items.map((i) => [i.title, i.startMinute, i.column])).toEqual([
      ["項目 0", 600, 3],
      ["項目 0", 660, 3],
      ["項目 1", 700, 4],
    ]);
    expect(plan).toMatchObject({ current: 3, total: 5, fits: true });
    // 今の項目が無ければ 0 列目から
    expect(planScheduleImport([], [fileItem(0)])).toMatchObject({ current: 0, total: 1, fits: true });
  });

  it("ファイルの列に飛びがあれば、使っている列だけで詰めて送る", () => {
    const plan = planScheduleImport(currentColumns(2), [fileItem(0), fileItem(5), fileItem(9)]);
    expect(plan.items.map((i) => i.column)).toEqual([2, 3, 4]);
    expect(plan).toMatchObject({ total: 5, fits: true });
  });

  it("今の列と取り込む列を合わせて、上限の列の数までなら取り込める", () => {
    const file = Array.from({ length: 10 }, (_, c) => fileItem(c));
    expect(planScheduleImport(currentColumns(40), file)).toMatchObject({
      current: 40,
      total: SCHEDULE_COLUMNS_MAX,
      fits: true,
    });
  });

  it("上限を超えるときは取り込めない", () => {
    const file = Array.from({ length: 15 }, (_, c) => fileItem(c));
    expect(planScheduleImport(currentColumns(41), file)).toMatchObject({ current: 41, total: 56, fits: false });
    // 今の項目が 1 つでもあれば、ファイルが上限いっぱい（50 列）だと超える
    const full = Array.from({ length: SCHEDULE_COLUMNS_MAX }, (_, c) => fileItem(c));
    expect(planScheduleImport(currentColumns(1), full).fits).toBe(false);
    expect(planScheduleImport([], full).fits).toBe(true);
  });

  it("同じ列で時間が重なる項目は右に押し出されるので、その分の列も数える（列の無い以前の形式を含む）", () => {
    // 列の無い項目が同じ時刻に 10 件：1 列ではなく 10 列になる
    const legacy = Array.from({ length: 10 }, () => fileItem(undefined));
    expect(planScheduleImport(currentColumns(40), legacy)).toMatchObject({ total: 50, fits: true });
    expect(planScheduleImport(currentColumns(41), legacy)).toMatchObject({ total: 51, fits: false });
    // 重ならない時刻なら 1 列に収まる
    const apart = Array.from({ length: 10 }, (_, i) => fileItem(undefined, i * 30));
    expect(planScheduleImport(currentColumns(41), apart)).toMatchObject({ total: 42, fits: true });
  });
});
