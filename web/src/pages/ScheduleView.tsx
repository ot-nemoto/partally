import { formatScheduleRange, type ScheduleResponse, type ScheduleStatus, scheduleStatuses } from "@partally/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, errorMessage } from "../api";
import { useOnReload } from "../hooks/useReload";

/** 「いま」「つぎ」を時刻に合わせて付け直す間隔 */
const TICK_MS = 30_000;

const STATUS_LABEL: Partial<Record<ScheduleStatus, string>> = { now: "いま", next: "つぎ" };

/**
 * 参加者に見せるスケジュール。開始時刻の早い順に並べ、今の時間の項目に「いま」、次の項目に「つぎ」を付け、
 * 終わった項目は薄くする（日付が決まっていれば、その日だけ）
 */
export function ScheduleView() {
  const [data, setData] = useState<ScheduleResponse>();
  const [state, setState] = useState<"loading" | "ok" | "hidden" | "error">("loading");
  const [now, setNow] = useState(() => new Date());

  // 「更新」を続けて押したとき、後から返ってきた古い応答で戻さない
  const latestRequest = useRef(0);
  const load = useCallback(() => {
    const request = ++latestRequest.current;
    api<ScheduleResponse>("GET", "/schedule")
      .then((res) => {
        if (request !== latestRequest.current) return;
        setData(res);
        setState("ok");
      })
      .catch((e) => {
        if (request !== latestRequest.current) return;
        setState(e instanceof ApiError && e.status === 404 ? "hidden" : "error");
      });
  }, []);
  useEffect(load, [load]);
  useOnReload(load);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  if (state === "hidden") return <p className="muted">今は公開されていません。</p>;
  if (state === "error") return <p className="error">{errorMessage(undefined)}</p>;
  if (!data) return <p className="muted">読み込み中…</p>;
  if (data.items.length === 0) return <p className="muted">まだスケジュールはありません。</p>;

  const statuses = scheduleStatuses(data.items, now, data.date);
  return (
    <>
      {data.date && <p className="schedule-day">{formatDate(data.date)}</p>}
      <ol className="schedule-list">
        {data.items.map((item) => {
          const status = statuses.get(item.itemId) ?? "none";
          const label = STATUS_LABEL[status];
          return (
            <li
              key={item.itemId}
              className={`card schedule-item ${status}`}
              aria-current={status === "now" ? "time" : undefined}
            >
              <div className="schedule-item-head">
                <span className="schedule-item-time">{formatScheduleRange(item)}</span>
                {label && <span className={`schedule-badge ${status}`}>{label}</span>}
              </div>
              <h3>{item.title}</h3>
              {item.detail && <p className="schedule-item-detail">{item.detail}</p>}
            </li>
          );
        })}
      </ol>
    </>
  );
}

/** 「2026-12-20」→「12月20日（日）」 */
function formatDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(y!, m! - 1, d!);
  return `${m}月${d}日（${"日月火水木金土"[day.getDay()]}）`;
}
