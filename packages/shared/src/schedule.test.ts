import { describe, expect, it } from "vitest";
import {
  formatMinute,
  formatScheduleRange,
  type ScheduleItemDto,
  scheduleColumns,
  scheduleItemRequestSchema,
  scheduleStatuses,
} from "./index.js";

const item = (itemId: string, start: string, durationMinutes: number): ScheduleItemDto => {
  const [h, m] = start.split(":").map(Number);
  return { itemId, title: itemId, detail: "", startMinute: h! * 60 + m!, durationMinutes };
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
