import {
  DAY_MINUTES,
  formatMinute,
  formatScheduleRange,
  SCHEDULE_DETAIL_MAX_LENGTH,
  SCHEDULE_MIN_DURATION,
  SCHEDULE_TITLE_MAX_LENGTH,
  type ScheduleItemDto,
  type ScheduleItemRequest,
  type ScheduleItemResponse,
  type ScheduleResponse,
  type SettingsResponse,
  scheduleColumns,
} from "@partally/shared";
import { type FormEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../api";
import { Modal } from "../../components/Modal";
import { PageTitle } from "../../components/PageTitle";
import { useOnReload } from "../../hooks/useReload";
import { ScheduleTransferButtons } from "./ScheduleTransfer";

/** タイムラインの 1 分の高さ（px）。1 時間 = 120px、10 分 = 20px */
const PX_PER_MINUTE = 2;
/** ドラッグ・新しい項目の時刻の刻み（分） */
const SNAP = SCHEDULE_MIN_DURATION;
/** 項目が無いときに見せる時間帯 */
const DEFAULT_RANGE = { start: 17 * 60, end: 23 * 60 };
/** 新しい項目の所要時間 */
const NEW_DURATION = 30;
/** ドラッグとみなす最小の移動量（px）。これより小さければクリック（編集）として扱う */
const DRAG_THRESHOLD = 4;
/** 所要時間のボタン（分） */
const DURATION_CHOICES = [5, 10, 15, 20, 30, 45, 60, 90, 120];

type Editing = { item?: ScheduleItemDto; startMinute: number; durationMinutes: number };

interface Drag {
  pointerId: number;
  itemId: string;
  mode: "move" | "resize";
  startY: number;
  dy: number;
  moved: boolean;
}

const snap = (minute: number) => Math.round(minute / SNAP) * SNAP;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/**
 * スケジュールの作成。縦の時間軸に項目をブロックで置き、ブロックの中央をドラッグすると開始時刻、
 * 下の端をドラッグすると所要時間を変える（5 分刻み）。空いている所を押すとその時刻に新しい項目を作り、
 * ブロックを押す（Enter）と編集する
 */
export function AdminSchedule() {
  const [items, setItems] = useState<ScheduleItemDto[]>();
  const [date, setDate] = useState("");
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<Editing>();
  const [drag, setDrag] = useState<Drag>();
  /** 時間帯を手で広げた分（分） */
  const [extra, setExtra] = useState({ before: 0, after: 0 });

  const load = useCallback(async () => {
    try {
      const res = await api<ScheduleResponse>("GET", "/admin/schedule");
      setItems(res.items);
      setDate(res.date);
      setError(undefined);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useOnReload(load);

  async function saveDate(next: string) {
    setDate(next);
    try {
      // 日付は設定の一部なので、今の設定に日付だけを差し替えて保存する
      const { settings } = await api<SettingsResponse>("GET", "/admin/settings");
      await api<SettingsResponse>("PUT", "/admin/settings", { ...settings, scheduleDate: next });
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  /**
   * 時刻・長さだけを変えて保存する。先に画面を変え、失敗したらその項目だけを元に戻す
   * （続けて動かしたほかの項目まで戻さないように）
   */
  async function saveTime(item: ScheduleItemDto, updated: ScheduleItemDto) {
    const replace = (next: ScheduleItemDto) =>
      setItems((list) => list?.map((i) => (i.itemId === next.itemId ? next : i)));
    replace(updated);
    try {
      const { itemId, ...body } = updated;
      await api<ScheduleItemResponse>("PUT", `/admin/schedule/${itemId}`, body satisfies ScheduleItemRequest);
    } catch (e) {
      replace(item);
      alert(errorMessage(e));
    }
  }

  const list = items ?? [];
  // 見せる時間帯は、項目の前後に 1 時間の余白を取り、時間の区切りにそろえる
  const first = list.length ? Math.min(...list.map((i) => i.startMinute)) : DEFAULT_RANGE.start;
  const last = list.length ? Math.max(...list.map((i) => i.startMinute + i.durationMinutes)) : DEFAULT_RANGE.end;
  const rangeStart = clamp(Math.floor((first - 60) / 60) * 60 - extra.before, 0, DAY_MINUTES);
  const rangeEnd = clamp(Math.ceil((last + 60) / 60) * 60 + extra.after, rangeStart + 60, DAY_MINUTES);
  const hours: number[] = [];
  for (let m = rangeStart; m <= rangeEnd; m += 60) hours.push(m);
  const columns = scheduleColumns(list);

  /**
   * ドラッグで動かした後の時刻と長さ。見えている時間軸の外には出さない（外へ動かしたいときは時間軸を広げる）。
   * ドラッグ中の表示と、離したときに保存する値の両方に使う
   */
  function moved(item: ScheduleItemDto, d: Drag): ScheduleItemDto {
    if (d.itemId !== item.itemId || !d.moved) return item;
    const delta = snap(d.dy / PX_PER_MINUTE);
    if (d.mode === "move") {
      return { ...item, startMinute: clamp(item.startMinute + delta, rangeStart, rangeEnd - item.durationMinutes) };
    }
    return { ...item, durationMinutes: clamp(item.durationMinutes + delta, SNAP, rangeEnd - item.startMinute) };
  }
  const preview = (item: ScheduleItemDto) => (drag ? moved(item, drag) : item);

  function onBlockPointerDown(e: ReactPointerEvent<HTMLElement>, item: ScheduleItemDto, mode: Drag["mode"]) {
    if (e.button !== 0 || drag) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ pointerId: e.pointerId, itemId: item.itemId, mode, startY: e.clientY, dy: 0, moved: false });
  }

  function onBlockPointerMove(e: ReactPointerEvent<HTMLElement>) {
    if (drag?.pointerId !== e.pointerId) return;
    const dy = e.clientY - drag.startY;
    setDrag({ ...drag, dy, moved: drag.moved || Math.abs(dy) >= DRAG_THRESHOLD });
  }

  function onBlockPointerUp(e: ReactPointerEvent<HTMLElement>, item: ScheduleItemDto) {
    if (drag?.pointerId !== e.pointerId) return;
    const dy = e.clientY - drag.startY;
    const finished = { ...drag, dy, moved: drag.moved || Math.abs(dy) >= DRAG_THRESHOLD };
    setDrag(undefined);
    if (!finished.moved) {
      // 動かさずに離したら編集する
      setEditing({ item, startMinute: item.startMinute, durationMinutes: item.durationMinutes });
      return;
    }
    const next = moved(item, finished);
    if (next.startMinute !== item.startMinute || next.durationMinutes !== item.durationMinutes) {
      void saveTime(item, next);
    }
  }

  // 空いている所を押して（指なら軽く触れて）離したら、その時刻に新しい項目を作る。スクロールしたときは作らない
  const [press, setPress] = useState<{ pointerId: number; y: number; minute: number }>();
  function onGridPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const top = e.currentTarget.getBoundingClientRect().top;
    const minute = clamp(
      Math.floor((rangeStart + (e.clientY - top) / PX_PER_MINUTE) / SNAP) * SNAP,
      0,
      DAY_MINUTES - SNAP,
    );
    setPress({ pointerId: e.pointerId, y: e.clientY, minute });
  }
  function onGridPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (press?.pointerId !== e.pointerId) return;
    setPress(undefined);
    if (Math.abs(e.clientY - press.y) >= DRAG_THRESHOLD) return;
    setEditing({ startMinute: press.minute, durationMinutes: Math.min(NEW_DURATION, DAY_MINUTES - press.minute) });
  }

  return (
    <section className="admin-schedule">
      <PageTitle en="Schedule" ja="スケジュール">
        <div className="title-actions">
          <label className="schedule-date">
            日付
            <input type="date" value={date} onChange={(e) => void saveDate(e.target.value)} />
          </label>
          <ScheduleTransferButtons items={items} date={date} onImported={() => void load()} />
          <button
            type="button"
            className="primary"
            onClick={() => {
              const start = list.length ? Math.min(last, DAY_MINUTES - NEW_DURATION) : DEFAULT_RANGE.start + 60;
              setEditing({ startMinute: start, durationMinutes: NEW_DURATION });
            }}
          >
            項目を追加
          </button>
        </div>
      </PageTitle>
      <p className="muted small">
        空いている所を押すと、その時刻に項目を作ります。項目をドラッグすると開始時刻、下の端をドラッグすると長さが変わります（5
        分刻み。10 分以下の項目の長さは編集で変えます）。項目を押すと編集できます。参加者に見せるかは Setting
        で決めます。
      </p>
      {error && <p className="error">{error}</p>}
      {!items && !error && <p className="muted">読み込み中…</p>}
      {items && (
        <>
          <button
            type="button"
            className="link schedule-extend"
            onClick={() => setExtra((x) => ({ ...x, before: x.before + 60 }))}
            disabled={rangeStart === 0}
          >
            ↑ 前に 1 時間広げる
          </button>
          <div className="schedule-timeline">
            <div className="schedule-hours" aria-hidden="true">
              {hours.map((m) => (
                <span key={m} className="schedule-hour" style={{ top: (m - rangeStart) * PX_PER_MINUTE }}>
                  {formatMinute(m)}
                </span>
              ))}
            </div>
            <div
              className="schedule-grid"
              style={{
                height: (rangeEnd - rangeStart) * PX_PER_MINUTE,
                backgroundSize: `100% ${30 * PX_PER_MINUTE}px`,
              }}
              onPointerDown={onGridPointerDown}
              onPointerUp={onGridPointerUp}
              onPointerCancel={() => setPress(undefined)}
            >
              {list.map((item) => {
                const shown = preview(item);
                const col = columns.get(item.itemId) ?? { column: 0, columns: 1 };
                const height = shown.durationMinutes * PX_PER_MINUTE;
                return (
                  <button
                    type="button"
                    key={item.itemId}
                    className={`schedule-block${drag?.itemId === item.itemId && drag.moved ? " dragging" : ""}${height < 24 ? " tiny" : height < 44 ? " short" : ""}`}
                    style={{
                      top: (shown.startMinute - rangeStart) * PX_PER_MINUTE,
                      height,
                      left: `${(col.column / col.columns) * 100}%`,
                      width: `calc(${100 / col.columns}% - 4px)`,
                    }}
                    aria-label={`${formatScheduleRange(shown)} ${item.title}（押すと編集）`}
                    onPointerDown={(e) => onBlockPointerDown(e, item, "move")}
                    onPointerMove={onBlockPointerMove}
                    onPointerUp={(e) => onBlockPointerUp(e, item)}
                    onPointerCancel={() => setDrag(undefined)}
                    onLostPointerCapture={() => setDrag(undefined)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setEditing({ item, startMinute: item.startMinute, durationMinutes: item.durationMinutes });
                      }
                    }}
                  >
                    <span className="schedule-block-time">{formatScheduleRange(shown)}</span>
                    <span className="schedule-block-title">{item.title}</span>
                    {/*
                      下の端をドラッグすると長さが変わる。とても短い項目は、指で触れる範囲が持ち手にかかって
                      移動できなくなるので出さない（長さは編集ダイアログで変える）
                    */}
                    {height >= 24 && (
                      <span
                        className="schedule-resize"
                        aria-hidden="true"
                        onPointerDown={(e) => onBlockPointerDown(e, item, "resize")}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
          <button
            type="button"
            className="link schedule-extend"
            onClick={() => setExtra((x) => ({ ...x, after: x.after + 60 }))}
            disabled={rangeEnd === DAY_MINUTES}
          >
            ↓ 後ろに 1 時間広げる
          </button>
          {list.length === 0 && <p className="muted">まだ項目がありません。</p>}
        </>
      )}
      {editing && (
        <ScheduleItemDialog
          editing={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            void load();
          }}
        />
      )}
    </section>
  );
}

function ScheduleItemDialog(props: { editing: Editing; onClose: () => void; onSaved: () => void }) {
  const { item } = props.editing;
  const [title, setTitle] = useState(item?.title ?? "");
  const [detail, setDetail] = useState(item?.detail ?? "");
  const [startMinute, setStartMinute] = useState(props.editing.startMinute);
  const [durationMinutes, setDurationMinutes] = useState(props.editing.durationMinutes);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const end = startMinute + durationMinutes;
  const problem =
    durationMinutes < SCHEDULE_MIN_DURATION
      ? `長さは ${SCHEDULE_MIN_DURATION} 分以上にしてください。`
      : end > DAY_MINUTES
        ? "終わりの時刻が 24:00 を越えています。"
        : undefined;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (problem) return;
    setSaving(true);
    setError(undefined);
    const body: ScheduleItemRequest = { title, detail, startMinute, durationMinutes };
    try {
      if (item) await api<ScheduleItemResponse>("PUT", `/admin/schedule/${item.itemId}`, body);
      else await api<ScheduleItemResponse>("POST", "/admin/schedule", body);
      props.onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!item || !confirm(`「${item.title}」を削除します。よろしいですか？`)) return;
    setSaving(true);
    try {
      await api("DELETE", `/admin/schedule/${item.itemId}`);
      props.onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <Modal
      className="dialog schedule-dialog"
      label={item ? "項目の編集" : "項目を追加"}
      onClose={props.onClose}
      closable={!saving}
    >
      <form className="card" onSubmit={onSubmit}>
        <h2>{item ? "項目の編集" : "項目を追加"}</h2>
        <label className="field">
          <span>タイトル</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={SCHEDULE_TITLE_MAX_LENGTH}
            required
            data-autofocus
          />
        </label>
        <div className="schedule-time-fields">
          <label className="field">
            <span>開始</span>
            <input
              type="time"
              step={SNAP * 60}
              value={toTimeValue(startMinute)}
              onChange={(e) => {
                const minute = fromTimeValue(e.target.value);
                if (minute !== undefined) setStartMinute(minute);
              }}
              required
            />
          </label>
          <span className="schedule-time-end muted">〜 {formatMinute(end)}</span>
        </div>
        <fieldset className="schedule-durations">
          <legend>長さ</legend>
          {DURATION_CHOICES.map((m) => (
            <button
              key={m}
              type="button"
              className={durationMinutes === m ? "on" : undefined}
              aria-pressed={durationMinutes === m}
              onClick={() => setDurationMinutes(m)}
              disabled={startMinute + m > DAY_MINUTES}
            >
              {m < 60 ? `${m} 分` : m % 60 === 0 ? `${m / 60} 時間` : `${Math.floor(m / 60)} 時間 ${m % 60} 分`}
            </button>
          ))}
          <label className="schedule-duration-custom">
            <input
              type="number"
              className="schedule-duration-input"
              min={SCHEDULE_MIN_DURATION}
              max={DAY_MINUTES}
              step={SNAP}
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(Number(e.target.value))}
              aria-label="長さ（分）"
            />
            分
          </label>
        </fieldset>
        <label className="field">
          <span>詳細（任意）</span>
          <textarea
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            maxLength={SCHEDULE_DETAIL_MAX_LENGTH}
            rows={3}
          />
        </label>
        {problem && <p className="error">{problem}</p>}
        {error && <p className="error">{error}</p>}
        <div className="buttons">
          {item && (
            <button type="button" className="danger schedule-delete" onClick={remove} disabled={saving}>
              削除
            </button>
          )}
          <button type="button" onClick={props.onClose} disabled={saving}>
            キャンセル
          </button>
          <button type="submit" className="primary" disabled={saving || problem !== undefined}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** 0:00 からの分を <input type="time"> の値（HH:MM）にする */
function toTimeValue(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function fromTimeValue(value: string): number | undefined {
  const m = /^(\d{2}):(\d{2})/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}
