import { describe, expect, it } from "vitest";
import { buildScheduleFile, readScheduleFile, SCHEDULE_FILE_MAX_ITEMS } from "./schedule-file.js";

const items = [
  { title: "乾杯", detail: "", startMinute: 18 * 60 + 15, durationMinutes: 5 },
  { title: "開場", detail: "受付は 1 階\n名札を受け取る", startMinute: 18 * 60, durationMinutes: 15 },
];
const file = (extra: Record<string, unknown>) =>
  JSON.stringify({ format: "partally-schedule", version: 1, exportedAt: "t", items, ...extra });
const errorOf = (text: string) => {
  const result = readScheduleFile(text);
  return result.ok ? undefined : result.error;
};

describe("スケジュールの JSON", () => {
  it("書き出して読むと、開始時刻の早い順の同じ項目と日付に戻る", () => {
    const text = buildScheduleFile({ date: "2026-12-24", items }, "2026-01-01T00:00:00.000Z");
    expect(JSON.parse(text).items.map((i: { title: string }) => i.title)).toEqual(["開場", "乾杯"]);
    expect(readScheduleFile(text)).toEqual({ ok: true, date: "2026-12-24", items: [items[1], items[0]] });
  });

  it("日付が無ければ日付なし。詳細を省くと空、先頭の BOM は無視する", () => {
    expect(readScheduleFile(buildScheduleFile({ items }, "t"))).toEqual({ ok: true, items: [items[1], items[0]] });
    expect(
      readScheduleFile(`﻿${file({ date: "", items: [{ title: "開場", startMinute: 0, durationMinutes: 30 }] })}`),
    ).toEqual({ ok: true, items: [{ title: "開場", detail: "", startMinute: 0, durationMinutes: 30 }] });
  });

  it("形の違うファイルや、項目の決まりに合わない中身は、理由を出して何も取り込まない", () => {
    expect(errorOf("{")).toContain("JSON の形になっていません");
    expect(errorOf(file({ format: "partally-prizes" }))).toContain("スケジュールのエクスポートの形ではありません");
    expect(errorOf(file({ version: 2 }))).toContain("対応していない版");
    expect(errorOf(file({ items: [] }))).toContain("1 つも入っていません");
    expect(errorOf(file({ items: Array.from({ length: SCHEDULE_FILE_MAX_ITEMS + 1 }, () => items[0]) }))).toContain(
      "多すぎます",
    );
    expect(errorOf(file({ date: "12/24" }))).toContain("日付");
    expect(errorOf(file({ items: [{ title: "", startMinute: 0, durationMinutes: 30 }] }))).toContain("1 件目");
    // 24:00 を越える・5 分未満
    expect(errorOf(file({ items: [{ title: "二次会", startMinute: 23 * 60 + 30, durationMinutes: 60 }] }))).toContain(
      "24:00 を越えています",
    );
    expect(errorOf(file({ items: [items[0], { title: "短い", startMinute: 0, durationMinutes: 1 }] }))).toContain(
      "2 件目（短い）",
    );
  });
});
