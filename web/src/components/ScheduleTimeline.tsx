import {
  formatMinute,
  formatScheduleRange,
  localDate,
  type ScheduleItemDto,
  type ScheduleStatus,
  scheduleStatuses,
} from "@partally/shared";
import { useEffect, useRef, useState } from "react";
import { type Lang, useLang, useT } from "../i18n";
import { Modal } from "./Modal";

const STATUS_LABEL: Partial<Record<ScheduleStatus, [ja: string, en: string]>> = {
  now: ["いま", "Now"],
  next: ["つぎ", "Next"],
};

/**
 * スケジュールの中身（日付と時間軸）。参加者の画面と、管理画面のプレビューで共通。
 * items は参加者に見せる項目（見せない列は除いて詰めたもの）。now の時刻で「いま」「つぎ」と今の線を決める
 */
export function ScheduleContent(props: { items: ScheduleItemDto[]; date: string; now: Date }) {
  const { items, date, now } = props;
  const t = useT();
  const lang = useLang();
  if (items.length === 0) return <p className="muted">{t("まだスケジュールはありません。", "No schedule yet.")}</p>;
  const statuses = scheduleStatuses(items, now, date);
  return (
    <>
      {date && <p className="schedule-day">{formatDate(date, lang)}</p>}
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
  const t = useT();
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

  // 開いたときに一度だけ、今の時刻の辺りまで縦にスクロールする（開いたときに線が無ければ、後から線が出てもスクロールしない）
  useEffect(() => {
    if (scrolled.current) return;
    scrolled.current = true;
    if (nowRef.current) scrollToCenter(nowRef.current);
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
              const labels = STATUS_LABEL[status];
              const label = labels && t(...labels);
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
                    aria-label={`${formatScheduleRange(item)} ${item.title}${label ? t(`（${label}）`, ` (${label})`) : ""}`}
                    onClick={() => setOpened(item)}
                  >
                    <span className="schedule-block-time">{formatScheduleRange(item)}</span>
                    {/* 狭い列・短い項目でもタイトルが隠れないよう、「いま」「つぎ」はタイトルの前に付ける */}
                    <span className="schedule-block-title">
                      {label && <span className={`schedule-badge ${status}`}>{label}</span>}
                      {item.title}
                    </span>
                    <ScheduleBlockDetail detail={item.detail} height={height} />
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
              <p className="muted small">{t("詳細はありません。", "No details.")}</p>
            )}
            <div className="buttons">
              <button type="button" onClick={() => setOpened(undefined)}>
                {t("閉じる", "Close")}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

/** 「2026-12-20」→「12月20日（日）」、英語では「Sun, Dec 20」 */
function formatDate(date: string, lang: Lang): string {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(y!, m! - 1, d!);
  if (lang === "en") return day.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return `${m}月${d}日（${"日月火水木金土"[day.getDay()]}）`;
}

/**
 * el が縦の真ん中に来るよう、いちばん近い縦にスクロールできる枠（プレビューの枠など）だけをスクロールする。
 * 枠が無ければ画面をスクロールする（ダイアログの中なら、背面の画面は動かさない）。横にはスクロールしない
 */
function scrollToCenter(el: HTMLElement) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p instanceof HTMLDialogElement) return;
    const overflowY = getComputedStyle(p).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && p.scrollHeight > p.clientHeight) {
      p.scrollTop += el.getBoundingClientRect().top - p.getBoundingClientRect().top - p.clientHeight / 2;
      return;
    }
  }
  window.scrollBy({ top: el.getBoundingClientRect().top - window.innerHeight / 2 });
}

/**
 * 項目の中で、時刻・タイトル・上下の余白が使う高さと、詳細の 1 行の高さ（rem。CSS の .schedule-block-detail の
 * line-height と同じ）。文字の大きさの設定に合わせて px にする
 */
const BLOCK_HEADER_REM = 2.875;
const DETAIL_LINE_REM = 1;
/** 時刻とタイトルを 1 行に並べる短い項目の高さ（px。これより低い項目には詳細も「詳細あり」も出さない） */
const SHORT_BLOCK_HEIGHT = 44;

function remPx(): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/**
 * 項目の中に出す詳細（改行もそのまま）。項目の高さに入る行数だけ出し、入りきらなければ「…」で切る。
 * 1 行も入らない項目には、詳細があることだけを右下に小さく出す（全文は、参加者の画面は押して出る詳細、
 * 管理画面は編集画面で見る）。reserved は下に空ける高さ（px。管理画面の長さを変える持ち手）
 */
export function ScheduleBlockDetail(props: { detail: string; height: number; reserved?: number }) {
  const t = useT();
  if (!props.detail || props.height < SHORT_BLOCK_HEIGHT) return null;
  const rem = remPx();
  const lines = Math.floor((props.height - BLOCK_HEADER_REM * rem - (props.reserved ?? 0)) / (DETAIL_LINE_REM * rem));
  if (lines < 1) {
    return (
      <span className="schedule-block-more" aria-hidden="true">
        {t("詳細あり", "More")}
      </span>
    );
  }
  return (
    <span className="schedule-block-detail" style={{ WebkitLineClamp: lines }}>
      {props.detail}
    </span>
  );
}
