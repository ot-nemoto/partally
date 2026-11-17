import { formatMinute, type ScheduleItemDto, type SettingsResponse, visibleSchedule } from "@partally/shared";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../../api";
import { Modal } from "../../../components/Modal";
import { ScheduleContent } from "../../../components/ScheduleTimeline";
import { useT } from "../../../i18n";

/** 今の時刻（0:00 からの分。5 分単位に切り捨て） */
function currentMinute(): number {
  const d = new Date();
  return Math.floor((d.getHours() * 60 + d.getMinutes()) / 5) * 5;
}

/**
 * 参加者の画面のプレビュー。スマホの大きさの枠に、参加者の画面と同じ部品でスケジュールを出す（見せない列は除いて詰める）。
 * 時刻を選ぶと、その時刻での「いま」「つぎ」と今の線を見られる（イベントの日付があれば、その日の時刻として見る）
 */
export function SchedulePreviewDialog(props: { items: ScheduleItemDto[]; date: string; onClose: () => void }) {
  const t = useT();
  const [minute, setMinute] = useState(currentMinute);
  const [visible, setVisible] = useState<boolean>();
  useEffect(() => {
    api<SettingsResponse>("GET", "/admin/settings")
      .then((res) => setVisible(res.settings.scheduleVisible))
      .catch(() => setVisible(undefined));
  }, []);

  const items = useMemo(() => visibleSchedule(props.items), [props.items]);
  const hiddenCount = props.items.length - items.length;
  const now = useMemo(() => {
    const day = props.date ? props.date.split("-").map(Number) : undefined;
    const base = day ? new Date(day[0]!, day[1]! - 1, day[2]!) : new Date();
    base.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
    return base;
  }, [minute, props.date]);

  return (
    <Modal
      className="dialog game-preview-dialog schedule-preview-dialog"
      label={t("プレビュー", "Preview")}
      onClose={props.onClose}
    >
      <div className="card">
        <h2>{t("プレビュー", "Preview")}</h2>
        <p className="muted small">
          {t(
            "参加者のスマホの「イベント情報」に出るスケジュールです。",
            "This is the schedule participants see in “Event info” on their phones.",
          )}
          {hiddenCount > 0 &&
            t(
              `参加者に見せない列の項目（${hiddenCount} 件）は出ません。`,
              ` Items in hidden columns (${hiddenCount}) aren’t shown.`,
            )}
          {visible === false &&
            t(
              "今は Setting で参加者に見せない設定なので、参加者には見えません。",
              " The schedule is currently hidden from participants in Setting.",
            )}
        </p>
        <div className="schedule-preview-time">
          <label>
            {t("この時刻で見る", "View at")}
            <input
              type="time"
              step={300}
              value={formatMinute(minute).padStart(5, "0")}
              onChange={(e) => {
                const [h, m] = e.target.value.split(":").map(Number);
                if (h !== undefined && m !== undefined && !Number.isNaN(h) && !Number.isNaN(m)) setMinute(h * 60 + m);
              }}
            />
          </label>
          <button type="button" className="link" onClick={() => setMinute(currentMinute())}>
            {t("今の時刻", "Now")}
          </button>
        </div>
        <div className="game-preview-phone">
          <div className="participant game-preview-screen">
            <main className="page">
              <ScheduleContent items={items} date={props.date} now={now} />
            </main>
          </div>
        </div>
        <div className="buttons">
          <button type="button" onClick={props.onClose}>
            {t("閉じる", "Close")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
