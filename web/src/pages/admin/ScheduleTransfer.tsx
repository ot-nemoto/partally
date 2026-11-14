import {
  formatScheduleRange,
  type ScheduleItemDto,
  type ScheduleItemResponse,
  type ScheduleResponse,
  type SettingsResponse,
} from "@partally/shared";
import {
  buildScheduleFile,
  readScheduleFile,
  SCHEDULE_FILE_MAX_BYTES,
  type ScheduleFile,
} from "@partally/shared/schedule-file";
import { useState } from "react";
import { api } from "../../api";
import { dateStamp } from "./transfer/files";
import { ImportDialog } from "./transfer/ImportDialog";
import { TransferButtons } from "./transfer/TransferButtons";

/**
 * スケジュールのエクスポート・インポートのボタン。エクスポートは今の項目と日付を JSON にしてダウンロードし、
 * インポートは中身を見せてから、今の項目に追加するか置き換えるかを選んで取り込む（日付は選んだときだけ取り込む）
 */
export function ScheduleTransferButtons(props: {
  items: ScheduleItemDto[] | undefined;
  date: string;
  onImported: () => void;
}) {
  const { items } = props;

  async function exportFile() {
    // 開いたままの画面ではなく、今の内容を書き出す
    const latest = await api<ScheduleResponse>("GET", "/admin/schedule");
    const now = new Date();
    const text = buildScheduleFile({ date: latest.date || undefined, items: latest.items }, now.toISOString());
    return {
      blob: new Blob([text], { type: "application/json" }),
      filename: `partally-schedule-${dateStamp(now)}.json`,
    };
  }

  return (
    <TransferButtons<ScheduleFile>
      canExport={!!items && items.length > 0}
      exportFile={exportFile}
      canImport={!!items}
      accept=".json,application/json"
      maxBytes={SCHEDULE_FILE_MAX_BYTES}
      read={async (file) => {
        const result = readScheduleFile(await file.text());
        return result.ok ? { ok: true, value: { date: result.date, items: result.items } } : result;
      }}
      renderImport={(schedule, close, done) => (
        <ScheduleImport schedule={schedule} current={items ?? []} date={props.date} onClose={close} onDone={done} />
      )}
      onImported={props.onImported}
    />
  );
}

function ScheduleImport(props: {
  schedule: ScheduleFile;
  current: ScheduleItemDto[];
  date: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { schedule, current } = props;
  const [withDate, setWithDate] = useState(false);
  return (
    <ImportDialog
      noun="項目"
      title="スケジュールのインポート"
      names={schedule.items.map((item) => item.title)}
      preview={
        <table className="import-table">
          <thead>
            <tr>
              <th>時刻</th>
              <th>タイトル</th>
              <th>詳細</th>
            </tr>
          </thead>
          <tbody>
            {schedule.items.map((item, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: ファイルの中の並びで、取り込みの間は変わらない
              <tr key={i}>
                <td className="nowrap">{formatScheduleRange(item)}</td>
                <td>{item.title}</td>
                <td className="muted small">{item.detail.split("\n")[0]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
      currentCount={current.length}
      allowReplace
      addNote="時間が重なる項目は、横に並べて表示します。"
      options={(disabled) =>
        schedule.date && (
          <label className="import-option">
            <input
              type="checkbox"
              checked={withDate}
              onChange={(e) => setWithDate(e.target.checked)}
              disabled={disabled}
            />
            イベントの日付も取り込む（{schedule.date}。今は{props.date ? ` ${props.date}` : "決めていない"}）
          </label>
        )
      }
      importItem={async (i) => {
        await api<ScheduleItemResponse>("POST", "/admin/schedule", schedule.items[i]);
      }}
      removeCurrent={current.map((item) => () => api("DELETE", `/admin/schedule/${item.itemId}`).then(() => {}))}
      afterImport={async () => {
        if (!withDate || !schedule.date) return;
        // 日付は設定の一部なので、今の設定に日付だけを差し替えて保存する
        const { settings } = await api<SettingsResponse>("GET", "/admin/settings");
        await api<SettingsResponse>("PUT", "/admin/settings", { ...settings, scheduleDate: schedule.date });
      }}
      onClose={props.onClose}
      onDone={props.onDone}
    />
  );
}
