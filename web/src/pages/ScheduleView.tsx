import {
  formatMinute,
  formatScheduleRange,
  localDate,
  type ScheduleItemDto,
  type ScheduleResponse,
  type ScheduleStatus,
  scheduleStatuses,
} from "@partally/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, errorMessage } from "../api";
import { Modal } from "../components/Modal";
import { useOnReload } from "../hooks/useReload";

/** 「いま」「つぎ」を時刻に合わせて付け直す間隔 */
const TICK_MS = 30_000;

const STATUS_LABEL: Partial<Record<ScheduleStatus, string>> = { now: "いま", next: "つぎ" };

/**
 * 参加者に見せるスケジュール。管理画面と同じ時間軸に、幹事が置いた列ごとに並べ、今の時間の項目に「いま」、次の項目に「つぎ」を付け、
 * 終わった項目は薄くする（日付が決まっていれば、その日だけ）
 */
export function ScheduleView() {
  const [data, setData] = useState<ScheduleResponse>();
  const [state, setState] = useState<"loading" | "ok" | "hidden" | "error">("loading");
  const [error, setError] = useState<string>();
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
        setError(errorMessage(e));
      });
  }, []);
  useEffect(load, [load]);
  useOnReload(load);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  if (state === "hidden") return <p className="muted">今は公開されていません。</p>;
  if (state === "error") return <p className="error">{error}</p>;
  if (!data) return <p className="muted">読み込み中…</p>;
  return <ScheduleContent items={data.items} date={data.date} now={now} />;
}

/**
 * スケジュールの中身（日付と時間軸）。参加者の画面と、管理画面のプレビューで共通。
 * items は参加者に見せる項目（見せない列は除いて詰めたもの）。now の時刻で「いま」「つぎ」と今の線を決める
 */
export function ScheduleContent(props: { items: ScheduleItemDto[]; date: string; now: Date }) {
  const { items, date, now } = props;
  if (items.length === 0) return <p className="muted">まだスケジュールはありません。</p>;
  const statuses = scheduleStatuses(items, now, date);
  return (
    <>
      {date && <p className="schedule-day">{formatDate(date)}</p>}
      <ScheduleBoard items={items} statuses={statuses} now={now} date={date} />
    </>
  );
}

/** 時間軸の 1 分の高さ（px）。1 時間 = 96px */
const PX_PER_MINUTE = 1.6;
/** 列の最小の幅（px）。収まらないときは横にスクロールする */
const COLUMN_MIN_WIDTH = 140;

/**
 * 時間軸に、幹事が置いた列ごとに項目を並べる（管理画面のタイムラインから操作を除いた形）。
 * 同じ時間に並行する項目が横に並び、項目の高さは長さに合う。今の時刻に線を引き、開いたときはそこまでスクロールする。
 * 項目を押すと詳細を出す
 */
function ScheduleBoard(props: {
  items: ScheduleItemDto[];
  statuses: Map<string, ScheduleStatus>;
  now: Date;
  date: string;
}) {
  const { items, statuses } = props;
  const [opened, setOpened] = useState<ScheduleItemDto>();
  const nowRef = useRef<HTMLSpanElement>(null);
  const scrolled = useRef(false);

  const columns = Math.max(1, ...items.map((i) => (i.column ?? 0) + 1));
  const start = Math.floor(Math.min(...items.map((i) => i.startMinute)) / 60) * 60;
  const end = Math.ceil(Math.max(...items.map((i) => i.startMinute + i.durationMinutes)) / 60) * 60;
  const hours: number[] = [];
  for (let m = start; m <= end; m += 60) hours.push(m);
  // 今の時刻の線は、その日（日付を決めていなければ毎日）の、時間軸の中にあるときだけ引く
  const minute = props.now.getHours() * 60 + props.now.getMinutes();
  const showNow = (!props.date || props.date === localDate(props.now)) && minute >= start && minute <= end;

  // 開いたときに一度だけ、今の時刻の辺りまで縦にスクロールする。線の左端の小さな印に合わせ、横にはスクロールしない
  // （線は列の幅いっぱいなので、線そのものに合わせると、時間軸やプレビューの枠が横にずれる）
  useEffect(() => {
    if (scrolled.current || !nowRef.current) return;
    scrolled.current = true;
    nowRef.current.scrollIntoView({ block: "center", inline: "nearest" });
  });

  return (
    <>
      <div className="schedule-board">
        <div className="schedule-timeline" style={{ minWidth: `calc(3.5rem + ${columns * COLUMN_MIN_WIDTH}px)` }}>
          <div className="schedule-hours" aria-hidden="true">
            {hours.map((m) => (
              <span key={m} className="schedule-hour" style={{ top: (m - start) * PX_PER_MINUTE }}>
                {formatMinute(m)}
              </span>
            ))}
          </div>
          <ol
            className="schedule-grid readonly"
            style={{ height: (end - start) * PX_PER_MINUTE, backgroundSize: `100% ${30 * PX_PER_MINUTE}px` }}
          >
            {items.map((item) => {
              const status = statuses.get(item.itemId) ?? "none";
              const label = STATUS_LABEL[status];
              const height = item.durationMinutes * PX_PER_MINUTE;
              const column = item.column ?? 0;
              return (
                <li
                  key={item.itemId}
                  className="schedule-board-slot"
                  style={{
                    top: (item.startMinute - start) * PX_PER_MINUTE,
                    height,
                    left: `${(column / columns) * 100}%`,
                    width: `${100 / columns}%`,
                  }}
                >
                  <button
                    type="button"
                    className={`schedule-block ${status}${label ? " badged" : ""}${height < 24 ? " tiny" : height < 44 ? " short" : ""}`}
                    aria-current={status === "now" ? "time" : undefined}
                    aria-label={`${formatScheduleRange(item)} ${item.title}${label ? `（${label}）` : ""}`}
                    onClick={() => setOpened(item)}
                  >
                    <span className="schedule-block-time">{formatScheduleRange(item)}</span>
                    {/* 狭い列・短い項目でもタイトルが隠れないよう、「いま」「つぎ」はタイトルの前に付ける */}
                    <span className="schedule-block-title">
                      {label && <span className={`schedule-badge ${status}`}>{label}</span>}
                      {item.title}
                    </span>
                  </button>
                </li>
              );
            })}
            {showNow && (
              <div className="schedule-now-line" style={{ top: (minute - start) * PX_PER_MINUTE }} aria-hidden="true">
                <span ref={nowRef} className="schedule-now-anchor" />
              </div>
            )}
          </ol>
        </div>
      </div>
      {opened && (
        <Modal className="dialog schedule-detail" label={opened.title} onClose={() => setOpened(undefined)}>
          <div className="card">
            <p className="schedule-item-time">{formatScheduleRange(opened)}</p>
            <h2>{opened.title}</h2>
            {opened.detail ? (
              <p className="schedule-item-detail">{opened.detail}</p>
            ) : (
              <p className="muted small">詳細はありません。</p>
            )}
            <div className="buttons">
              <button type="button" onClick={() => setOpened(undefined)}>
                閉じる
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

/** 「2026-12-20」→「12月20日（日）」 */
function formatDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(y!, m! - 1, d!);
  return `${m}月${d}日（${"日月火水木金土"[day.getDay()]}）`;
}
