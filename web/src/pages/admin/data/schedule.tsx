import { formatScheduleRange, type ScheduleItemResponse, type ScheduleResponse } from "@partally/shared";
import type { ScheduleFile, ScheduleFileItem } from "@partally/shared/schedule-file";
import { api } from "../../../api";

/** 今のスケジュール（項目とイベントの日付）を書き出す形にする */
export async function exportSchedule(): Promise<ScheduleFile> {
  const { items, date } = await api<ScheduleResponse>("GET", "/admin/schedule");
  return { date: date || undefined, items };
}

/** スケジュールの項目を 1 件作る */
export async function importScheduleItem(item: ScheduleFileItem): Promise<void> {
  await api<ScheduleItemResponse>("POST", "/admin/schedule", item);
}

/** 取り込む項目の一覧（時刻・タイトル・詳細の 1 行目） */
export function SchedulePreview(props: { items: ScheduleFileItem[] }) {
  return (
    <table className="import-table">
      <thead>
        <tr>
          <th>時刻</th>
          <th className="num">列</th>
          <th>タイトル</th>
          <th>詳細</th>
        </tr>
      </thead>
      <tbody>
        {props.items.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: ファイルの中の並びで、取り込みの間は変わらない
          <tr key={i}>
            <td className="nowrap">{formatScheduleRange(item)}</td>
            <td className="num">{(item.column ?? 0) + 1}</td>
            <td>{item.title}</td>
            <td className="muted small">{item.detail.split("\n")[0]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
