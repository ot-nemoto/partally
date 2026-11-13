import { isRecord, issueText } from "./archive-json.js";
import { scheduleItemRequestSchema, updateSettingsRequestSchema } from "./schemas.js";

/**
 * スケジュールのエクスポート・インポートに使う JSON ファイル。項目とイベントの日付を入れる
 * （画像が無いので ZIP にせず、手で直しやすい 1 つの JSON にする）。API は使わないので index からは読み込まない。
 * 画面から `@partally/shared/schedule-file` で読み込む
 */

/** format。別のアプリの JSON や、景品・ゲームの一覧を取り違えて取り込まないための印 */
export const SCHEDULE_FILE_FORMAT = "partally-schedule";
export const SCHEDULE_FILE_VERSION = 1;
/** 1 回で取り込める項目の数 */
export const SCHEDULE_FILE_MAX_ITEMS = 200;
/** 取り込めるファイルの大きさ */
export const SCHEDULE_FILE_MAX_BYTES = 1024 * 1024;

export interface ScheduleFileItem {
  title: string;
  detail: string;
  /** 0:00 からの分 */
  startMinute: number;
  durationMinutes: number;
}

export interface ScheduleFile {
  /** イベントの日付（YYYY-MM-DD）。決めていなければ無い */
  date?: string;
  items: ScheduleFileItem[];
}

/** スケジュールを JSON にする（項目は開始時刻の早い順） */
export function buildScheduleFile(schedule: ScheduleFile, exportedAt: string): string {
  const items = [...schedule.items]
    .sort((a, b) => a.startMinute - b.startMinute)
    .map(({ title, detail, startMinute, durationMinutes }) => ({ title, detail, startMinute, durationMinutes }));
  const file = {
    format: SCHEDULE_FILE_FORMAT,
    version: SCHEDULE_FILE_VERSION,
    exportedAt,
    ...(schedule.date ? { date: schedule.date } : {}),
    items,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export type ScheduleFileResult = ({ ok: true } & ScheduleFile) | { ok: false; error: string };

/**
 * JSON を読み、取り込める形か確かめる。各項目はスケジュールの項目の作成と同じ決まり（scheduleItemRequestSchema）で確かめ、
 * 1 つでも問題があれば、何も取り込まないよう全体を失敗にする
 */
export function readScheduleFile(text: string): ScheduleFileResult {
  if (text.length > SCHEDULE_FILE_MAX_BYTES) return fail("ファイルが大きすぎます（1MB まで）。");
  let file: unknown;
  try {
    file = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return fail("ファイルを読めませんでした（JSON の形になっていません）。エクスポートしたファイルを選んでください。");
  }
  if (!isRecord(file) || file.format !== SCHEDULE_FILE_FORMAT) {
    return fail("スケジュールのエクスポートの形ではありません。");
  }
  if (file.version !== SCHEDULE_FILE_VERSION)
    return fail(`対応していない版のファイルです（${String(file.version)}）。`);
  if (!Array.isArray(file.items)) return fail("スケジュールの項目の一覧（items）がありません。");
  if (file.items.length === 0) return fail("項目が 1 つも入っていません。");
  if (file.items.length > SCHEDULE_FILE_MAX_ITEMS) {
    return fail(`項目が多すぎます（1 回に ${SCHEDULE_FILE_MAX_ITEMS} 件まで）。`);
  }
  let date: string | undefined;
  if (file.date !== undefined && file.date !== null && file.date !== "") {
    const parsed = updateSettingsRequestSchema.shape.scheduleDate.safeParse(file.date);
    if (!parsed.success || !parsed.data)
      return fail("イベントの日付（date）が正しくありません（YYYY-MM-DD の形にしてください）。");
    date = parsed.data;
  }
  const items: ScheduleFileItem[] = [];
  for (const [i, raw] of file.items.entries()) {
    const label = `${i + 1} 件目`;
    if (!isRecord(raw)) return fail(`${label}: 項目の形になっていません。`);
    const parsed = scheduleItemRequestSchema.safeParse({
      title: raw.title,
      detail: raw.detail ?? "",
      startMinute: raw.startMinute,
      durationMinutes: raw.durationMinutes,
    });
    if (!parsed.success) return fail(`${label}（${String(raw.title ?? "")}）: ${issueText(parsed.error.issues)}`);
    items.push(parsed.data);
  }
  items.sort((a, b) => a.startMinute - b.startMinute);
  return { ok: true, ...(date ? { date } : {}), items };
}

function fail(error: string): ScheduleFileResult {
  return { ok: false, error };
}
