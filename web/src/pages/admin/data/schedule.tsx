import { formatScheduleRange, type ScheduleItemResponse, type ScheduleResponse } from "@partally/shared";
import type { ScheduleFile, ScheduleFileItem } from "@partally/shared/schedule-file";
import { api } from "../../../api";
import { useT } from "../../../i18n";

/** 今のスケジュール（項目とイベントの日付）を書き出す形にする */
export async function exportSchedule(): Promise<ScheduleFile> {
  const { items, date } = await api<ScheduleResponse>("GET", "/admin/schedule");
  return { date: date || undefined, items };
}

/** スケジュールの項目を 1 件作る */
export async function importScheduleItem(item: ScheduleFileItem): Promise<void> {
  await api<ScheduleItemResponse>("POST", "/admin/schedule", item);
}

/** 取り込む項目の一覧（時刻・列（参加者に見せない列か）・タイトル・詳細の 1 行目） */
export function SchedulePreview(props: { items: ScheduleFileItem[] }) {
  const t = useT();
  return (
    <table className="import-table">
      <thead>
        <tr>
          <th>{t("時刻", "Time")}</th>
          <th className="num">{t("列", "Column")}</th>
          <th>{t("タイトル", "Title")}</th>
          <th>{t("詳細", "Details")}</th>
        </tr>
      </thead>
      <tbody>
        {props.items.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: ファイルの中の並びで、取り込みの間は変わらない
          <tr key={i}>
            <td className="nowrap">{formatScheduleRange(item)}</td>
            <td className="num nowrap">
              {(item.column ?? 0) + 1}
              {item.hidden && <span className="muted small">{t("（見せない）", " (hidden)")}</span>}
            </td>
            <td>{item.title}</td>
            <td className="muted small">{item.detail.split("\n")[0]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
