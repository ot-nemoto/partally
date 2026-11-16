import { describe, expect, it } from "vitest";
import {
  arrangeScheduleColumns,
  formatMinute,
  formatScheduleRange,
  type ScheduleItemDto,
  scheduleColumns,
  scheduleItemRequestSchema,
  scheduleStatuses,
} from "./index.js";

const item = (itemId: string, start: string, durationMinutes: number): ScheduleItemDto => {
  const [h, m] = start.split(":").map(Number);
  return { itemId, title: itemId, detail: "", startMinute: h! * 60 + m!, durationMinutes, column: 0 };
};

describe("formatMinute / formatScheduleRange", () => {
  it("時:分で書く", () => {
    expect(formatMinute(0)).toBe("0:00");
    expect(formatMinute(18 * 60 + 5)).toBe("18:05");
    expect(formatMinute(24 * 60)).toBe("24:00");
    expect(formatScheduleRange(item("a", "18:00", 15))).toBe("18:00〜18:15");
  });
});

describe("scheduleStatuses", () => {
  const items = [
    item("open", "18:00", 15),
    item("toast", "18:15", 10),
    item("quiz", "19:00", 30),
    item("game", "19:00", 20),
  ];
  const at = (time: string, day = "2026-12-20") => new Date(`${day}T${time}:00`);
  const statuses = (now: Date, date = "") => Object.fromEntries(scheduleStatuses(items, now, date));

  it("終わった・いま・つぎを決める。終わりの時刻ちょうどは終わった扱い", () => {
    expect(statuses(at("18:15"))).toEqual({ open: "past", toast: "now", quiz: "next", game: "next" });
  });

  it("項目の間の時間は「いま」なしで、次に始まるものが「つぎ」", () => {
    expect(statuses(at("18:40"))).toEqual({ open: "past", toast: "past", quiz: "next", game: "next" });
  });

  it("重なっている項目はどちらも「いま」", () => {
    expect(statuses(at("19:10"))).toEqual({ open: "past", toast: "past", quiz: "now", game: "now" });
  });

  it("日付があれば、その日だけ判定する", () => {
    expect(statuses(at("18:05"), "2026-12-20").open).toBe("now");
    expect(Object.values(statuses(at("18:05", "2026-12-19"), "2026-12-20"))).toEqual(["none", "none", "none", "none"]);
  });
});

describe("scheduleColumns", () => {
  it("重なる項目は横に並べ、重ならないまとまりは 1 列", () => {
    const cols = scheduleColumns([
      item("a", "18:00", 60),
      item("b", "18:30", 60),
      item("c", "19:00", 30),
      item("d", "20:00", 30),
    ]);
    expect(Object.fromEntries(cols)).toEqual({
      a: { column: 0, columns: 2 },
      b: { column: 1, columns: 2 },
      c: { column: 0, columns: 2 },
      d: { column: 0, columns: 1 },
    });
  });
});

describe("scheduleItemRequestSchema", () => {
  it("終わりが 24:00 を越える・5 分未満・空のタイトルは拒否する", () => {
    const base = { title: "乾杯", detail: "", startMinute: 18 * 60, durationMinutes: 15 };
    expect(scheduleItemRequestSchema.safeParse(base).success).toBe(true);
    expect(
      scheduleItemRequestSchema.safeParse({ ...base, startMinute: 23 * 60 + 50, durationMinutes: 15 }).success,
    ).toBe(false);
    expect(scheduleItemRequestSchema.safeParse({ ...base, durationMinutes: 4 }).success).toBe(false);
    expect(scheduleItemRequestSchema.safeParse({ ...base, title: "  " }).success).toBe(false);
    expect(
      scheduleItemRequestSchema.safeParse({ ...base, startMinute: 23 * 60 + 55, durationMinutes: 5 }).success,
    ).toBe(true);
  });
});

describe("arrangeScheduleColumns（幹事が置く列）", () => {
  // [itemId, 開始, 長さ, 列]
  const items = (...list: [string, number, number, number?][]) =>
    list.map(([itemId, startMinute, durationMinutes, column]) => ({ itemId, startMinute, durationMinutes, column }));
  const of = (map: Map<string, number>) => Object.fromEntries(map);

  it("置いた列のまま。重ならなければ、同じ時刻でも別の列に置ける", () => {
    expect(of(arrangeScheduleColumns(items(["a", 0, 30, 0], ["b", 0, 30, 1], ["c", 30, 30, 0]), "c"))).toEqual({
      a: 0,
      b: 1,
      c: 0,
    });
  });

  it("同じ列で時間が重なったら、すぐ右に列を足して移す（右の列は 1 つずつ右へずれる）", () => {
    // a（列 0）と重なる d を列 0 に置く → d は列 1 へ、もとの列 1 の b は列 2 へ
    const result = arrangeScheduleColumns(items(["a", 0, 30, 0], ["b", 0, 60, 1], ["d", 15, 30, 0]), "d");
    expect(of(result)).toEqual({ a: 0, d: 1, b: 2 });
  });

  it("終わりと始まりが同じ時刻なら重ならない", () => {
    expect(of(arrangeScheduleColumns(items(["a", 0, 30, 0], ["b", 30, 30, 0]), "b"))).toEqual({ a: 0, b: 0 });
  });

  it("何もない列は詰める（勝手に並べ替えはしない）", () => {
    // 列 1 が空いている
    expect(of(arrangeScheduleColumns(items(["a", 0, 30, 0], ["b", 0, 30, 2], ["c", 60, 30, 3])))).toEqual({
      a: 0,
      b: 1,
      c: 2,
    });
  });

  it("列を超えて動かせる（動かした先で重なれば、そのすぐ右に移す）", () => {
    // c を列 0 から列 1（b と重なる）へ動かす → c は列 2 へ、空いた列 0 は a が残るのでそのまま
    const result = arrangeScheduleColumns(items(["a", 0, 30, 0], ["b", 0, 30, 1], ["c", 0, 30, 1]), "c");
    expect(of(result)).toEqual({ a: 0, b: 1, c: 2 });
  });

  it("列を持たない項目（列を持つ前に作った項目）は、時刻から決めた以前の並べ方の列に置く", () => {
    expect(of(arrangeScheduleColumns(items(["a", 0, 60], ["b", 30, 60], ["c", 90, 30])))).toEqual({
      a: 0,
      b: 1,
      c: 0,
    });
  });
});
