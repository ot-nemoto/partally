import {
  arrangeScheduleColumns,
  DAY_MINUTES,
  formatMinute,
  formatScheduleRange,
  placedScheduleHidden,
  SCHEDULE_DETAIL_MAX_LENGTH,
  SCHEDULE_MIN_DURATION,
  SCHEDULE_TITLE_MAX_LENGTH,
  type ScheduleColumnRequest,
  type ScheduleItemDto,
  type ScheduleItemRequest,
  type ScheduleItemResponse,
  type ScheduleResponse,
  type SettingsResponse,
} from "@partally/shared";
import { type FormEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../api";
import { Modal } from "../../components/Modal";
import { PageTitle } from "../../components/PageTitle";
import { ScheduleBlockDetail } from "../../components/ScheduleTimeline";
import { useFreshList } from "../../hooks/useFreshList";
import { useOnReload } from "../../hooks/useReload";
import { tr, useT } from "../../i18n";
import { SchedulePreviewDialog } from "./schedule/SchedulePreviewDialog";

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

/** 編集中の項目。新しく作るときは、置く列（column）も持つ */
type Editing = { item?: ScheduleItemDto; startMinute: number; durationMinutes: number; column?: number };

interface Drag {
  pointerId: number;
  itemId: string;
  mode: "move" | "resize";
  startY: number;
  dy: number;
  /** 押したときと今の、指・ポインタの横の位置（列を超えて動かすときに、どの列の上にあるかを決める） */
  startX: number;
  x: number;
  /** 時間軸（列を並べる所）の左端と幅 */
  gridLeft: number;
  gridWidth: number;
  moved: boolean;
}

const snap = (minute: number) => Math.round(minute / SNAP) * SNAP;

/**
 * 列と見せるかを決め直した一覧（placedId の項目が重なれば右に列を足し、何もない列は詰める。
 * placedId の項目は置いた列の見せるかに合わせる。サーバと同じ決まり）
 */
function arranged(items: ScheduleItemDto[], placedId?: string): ScheduleItemDto[] {
  const columns = arrangeScheduleColumns(items, placedId);
  const hidden = placedId === undefined ? undefined : placedScheduleHidden(items, placedId);
  return items.map((i) => ({
    ...i,
    column: columns.get(i.itemId) ?? 0,
    ...(i.itemId === placedId ? { hidden: hidden! } : {}),
  }));
}
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/**
 * スケジュールの作成。縦の時間軸に項目をブロックで置き、ブロックの中央をドラッグすると開始時刻と列、
 * 下の端をドラッグすると所要時間を変える（5 分刻み）。空いている所を押すとその時刻・列に新しい項目を作り、
 * ブロックを押す（Enter）と編集する。列は幹事が置いたまま勝手に並べ替えず、同じ列で時間が重なったら
 * すぐ右に列を足して移し、何もない列は詰める（arrangeScheduleColumns。サーバも同じ決まりで保存する）
 */
export function AdminSchedule() {
  const t = useT();
  const [items, setItems] = useState<ScheduleItemDto[]>();
  const [date, setDate] = useState("");
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<Editing>();
  const [previewing, setPreviewing] = useState(false);
  const [drag, setDrag] = useState<Drag>();
  /** 時間帯を手で広げた分（分） */
  const [extra, setExtra] = useState({ before: 0, after: 0 });

  // 保存・削除の直後に取り直した一覧が古くても、保存したものを出し、削除したものを出さない
  const { saved, removed, merge, apply } = useFreshList(itemIdOf);

  const load = useCallback(async () => {
    try {
      const res = await api<ScheduleResponse>("GET", "/admin/schedule");
      setItems(merge(res.items));
      setDate(res.date);
      setError(undefined);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [merge]);
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
   * 時刻・長さ・列を変えて保存する。先に画面を変え（重なりで足す列・詰める列もサーバと同じ決まりで決める）、
   * 保存できたらサーバの内容で読み直す。失敗したら読み直して元に戻す
   */
  async function saveMove(updated: ScheduleItemDto) {
    setItems(
      (list) =>
        list &&
        arranged(
          list.map((i) => (i.itemId === updated.itemId ? updated : i)),
          updated.itemId,
        ),
    );
    try {
      const { itemId, ...body } = updated;
      saved(
        (await api<ScheduleItemResponse>("PUT", `/admin/schedule/${itemId}`, body satisfies ScheduleItemRequest)).item,
      );
    } catch (e) {
      alert(errorMessage(e));
    }
    await load();
  }

  /** 列を参加者に見せるかを切り替える（その列の項目をまとめて）。先に画面を変え、保存できたらサーバの内容にする */
  async function toggleColumn(column: number, hidden: boolean) {
    setItems((list) => list?.map((i) => (i.column === column ? { ...i, hidden } : i)));
    try {
      const res = await api<ScheduleResponse>("PUT", `/admin/schedule/columns/${column}`, {
        hidden,
      } satisfies ScheduleColumnRequest);
      setItems(merge(res.items));
    } catch (e) {
      alert(errorMessage(e));
      await load();
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

  /**
   * ドラッグで動かした後の時刻と長さ。見えている時間軸の外には出さない（外へ動かしたいときは時間軸を広げる）。
   * ドラッグ中の表示と、離したときに保存する値の両方に使う
   */
  function moved(item: ScheduleItemDto, d: Drag): ScheduleItemDto {
    if (d.itemId !== item.itemId || !d.moved) return item;
    const delta = snap(d.dy / PX_PER_MINUTE);
    if (d.mode === "move") {
      // 横は、指・ポインタがどの列の上にあるかで決める（列を超えて動かせる）
      // 動かしている間は右に空いた列を 1 つ見せ、そこに置くと新しい列になる
      const slots = columnCount + 1;
      const column = clamp(Math.floor(((d.x - d.gridLeft) / d.gridWidth) * slots), 0, slots - 1);
      return {
        ...item,
        startMinute: clamp(item.startMinute + delta, rangeStart, rangeEnd - item.durationMinutes),
        column,
      };
    }
    return { ...item, durationMinutes: clamp(item.durationMinutes + delta, SNAP, rangeEnd - item.startMinute) };
  }
  const columnCount = Math.max(1, ...list.map((i) => i.column + 1));
  // ドラッグ中は、離したときと同じ決まりで列を決めて見せる（重なれば右に列が足される）
  const shownList = drag?.moved
    ? arranged(
        list.map((i) => moved(i, drag)),
        drag.itemId,
      )
    : list;
  // 動かしている間は、新しい列を作れるよう右に空いた列を 1 つ足して見せる
  const dragSlots = drag?.moved && drag.mode === "move" ? columnCount + 1 : 0;
  const shownColumns = Math.max(1, dragSlots, ...shownList.map((i) => i.column + 1));
  /** 列ごとに参加者に見せないか（項目の無い列は undefined） */
  const columnHidden = Array.from({ length: shownColumns }, (_, c) => {
    const inColumn = shownList.filter((i) => i.column === c);
    return inColumn.length === 0 ? undefined : inColumn.some((i) => i.hidden);
  });

  function onBlockPointerDown(e: ReactPointerEvent<HTMLElement>, item: ScheduleItemDto, mode: Drag["mode"]) {
    if (e.button !== 0 || drag) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const grid = e.currentTarget.closest(".schedule-grid")?.getBoundingClientRect();
    setDrag({
      pointerId: e.pointerId,
      itemId: item.itemId,
      mode,
      startY: e.clientY,
      dy: 0,
      startX: e.clientX,
      x: e.clientX,
      gridLeft: grid?.left ?? 0,
      gridWidth: grid?.width || 1,
      moved: false,
    });
  }

  /** ドラッグとみなすか（縦・横のどちらかに少し動いたら） */
  const isMoved = (d: Drag, dy: number, x: number) =>
    d.moved || Math.abs(dy) >= DRAG_THRESHOLD || (d.mode === "move" && Math.abs(x - d.startX) >= DRAG_THRESHOLD);

  function onBlockPointerMove(e: ReactPointerEvent<HTMLElement>) {
    if (drag?.pointerId !== e.pointerId) return;
    const dy = e.clientY - drag.startY;
    setDrag({ ...drag, dy, x: e.clientX, moved: isMoved(drag, dy, e.clientX) });
  }

  function onBlockPointerUp(e: ReactPointerEvent<HTMLElement>, item: ScheduleItemDto) {
    if (drag?.pointerId !== e.pointerId) return;
    const dy = e.clientY - drag.startY;
    const finished = { ...drag, dy, x: e.clientX, moved: isMoved(drag, dy, e.clientX) };
    setDrag(undefined);
    if (!finished.moved) {
      // 動かさずに離したら編集する
      setEditing({ item, startMinute: item.startMinute, durationMinutes: item.durationMinutes });
      return;
    }
    const next = moved(item, finished);
    if (
      next.startMinute !== item.startMinute ||
      next.durationMinutes !== item.durationMinutes ||
      next.column !== item.column
    ) {
      void saveMove(next);
    }
  }

  // 空いている所を押して（指なら軽く触れて）離したら、その時刻に新しい項目を作る。スクロールしたときは作らない
  const [press, setPress] = useState<{ pointerId: number; y: number; minute: number; column: number }>();
  function onGridPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const top = rect.top;
    const column = clamp(Math.floor(((e.clientX - rect.left) / (rect.width || 1)) * columnCount), 0, columnCount - 1);
    const minute = clamp(
      Math.floor((rangeStart + (e.clientY - top) / PX_PER_MINUTE) / SNAP) * SNAP,
      0,
      DAY_MINUTES - SNAP,
    );
    setPress({ pointerId: e.pointerId, y: e.clientY, minute, column });
  }
  function onGridPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (press?.pointerId !== e.pointerId) return;
    setPress(undefined);
    if (Math.abs(e.clientY - press.y) >= DRAG_THRESHOLD) return;
    setEditing({
      startMinute: press.minute,
      durationMinutes: Math.min(NEW_DURATION, DAY_MINUTES - press.minute),
      column: press.column,
    });
  }

  return (
    <section className="admin-schedule">
      <PageTitle en="Schedule" ja="スケジュール">
        <div className="title-actions">
          <label className="schedule-date">
            {t("日付", "Date")}
            <input type="date" value={date} onChange={(e) => void saveDate(e.target.value)} />
          </label>
          <button type="button" onClick={() => setPreviewing(true)} disabled={!items}>
            {t("プレビュー", "Preview")}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              const start = list.length ? Math.min(last, DAY_MINUTES - NEW_DURATION) : DEFAULT_RANGE.start + 60;
              setEditing({ startMinute: start, durationMinutes: NEW_DURATION });
            }}
          >
            {t("項目を追加", "Add item")}
          </button>
        </div>
      </PageTitle>
      <p className="muted small">
        {t(
          "空いている所を押すと、その時刻・列に項目を作ります。項目を上下にドラッグすると開始時刻、左右にドラッグすると列、下の端をドラッグすると長さが変わります（5 分刻み。10 分以下の項目の長さは編集で変えます）。同じ列で時間が重なると、すぐ右に列を足して移し、何もない列は消えます。項目を押すと編集できます。列の上のボタンで、列ごとに参加者に見せるかを切り替えられます（見せない列は斜線。項目は置いた列に合わせます）。スケジュール全体を参加者に見せるかは Setting で決めます。",
          "Click an empty spot to add an item at that time and column. Drag an item up/down to change its start time, left/right to change its column, and its bottom edge to change its length (in 5-minute steps; change items of 10 minutes or less in the editor). When items overlap in a column, the item moves to a new column right next to it, and empty columns disappear. Click an item to edit it. Use the buttons above the columns to show or hide each column for participants (hidden columns are striped; an item follows the column it’s placed in). Whether participants see the schedule at all is set in Setting.",
        )}
      </p>
      {error && <p className="error">{error}</p>}
      {!items && !error && <p className="muted">{t("読み込み中…", "Loading…")}</p>}
      {items && (
        <>
          <button
            type="button"
            className="link schedule-extend"
            onClick={() => setExtra((x) => ({ ...x, before: x.before + 60 }))}
            disabled={rangeStart === 0}
          >
            {t("↑ 前に 1 時間広げる", "↑ Show 1 more hour before")}
          </button>
          {list.length > 0 && (
            <div className="schedule-column-heads" style={{ gridTemplateColumns: `repeat(${shownColumns}, 1fr)` }}>
              {columnHidden.map((hidden, c) =>
                hidden === undefined ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 列の番号そのもの
                  <span key={c} />
                ) : (
                  <button
                    // biome-ignore lint/suspicious/noArrayIndexKey: 列の番号そのもの
                    key={c}
                    type="button"
                    className={`schedule-column-toggle${hidden ? " off" : ""}`}
                    aria-pressed={!hidden}
                    aria-label={t(`列 ${c + 1} を参加者に見せる`, `Show column ${c + 1} to participants`)}
                    title={
                      hidden
                        ? t("参加者に見せていません（押すと見せる）", "Hidden from participants (click to show)")
                        : t("参加者に見せています（押すと見せない）", "Shown to participants (click to hide)")
                    }
                    disabled={drag?.moved}
                    onClick={() => void toggleColumn(c, !hidden)}
                  >
                    {hidden ? t("見せない", "Hidden") : t("見せる", "Shown")}
                  </button>
                ),
              )}
            </div>
          )}
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
              {columnHidden.map(
                (hidden, c) =>
                  hidden && (
                    <span
                      // biome-ignore lint/suspicious/noArrayIndexKey: 列の番号そのもの
                      key={c}
                      className="schedule-column-shade"
                      aria-hidden="true"
                      style={{ left: `${(c / shownColumns) * 100}%`, width: `${100 / shownColumns}%` }}
                    />
                  ),
              )}
              {shownList.map((shown) => {
                const item = list.find((i) => i.itemId === shown.itemId)!;
                const height = shown.durationMinutes * PX_PER_MINUTE;
                return (
                  <button
                    type="button"
                    key={item.itemId}
                    className={`schedule-block${shown.hidden ? " hidden-item" : ""}${drag?.itemId === item.itemId && drag.moved ? " dragging" : ""}${height < 24 ? " tiny" : height < 44 ? " short" : ""}`}
                    style={{
                      top: (shown.startMinute - rangeStart) * PX_PER_MINUTE,
                      height,
                      left: `${(shown.column / shownColumns) * 100}%`,
                      width: `calc(${100 / shownColumns}% - 4px)`,
                    }}
                    aria-label={`${formatScheduleRange(shown)} ${item.title}${shown.hidden ? t("（参加者に見せない）", " (hidden from participants)") : ""}${t("（押すと編集）", " (click to edit)")}`}
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
                    {/* 下の端の持ち手の分を空ける */}
                    <ScheduleBlockDetail detail={item.detail} height={height} reserved={8} />
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
            {t("↓ 後ろに 1 時間広げる", "↓ Show 1 more hour after")}
          </button>
          {list.length === 0 && <p className="muted">{t("まだ項目がありません。", "No items yet.")}</p>}
        </>
      )}
      {previewing && items && <SchedulePreviewDialog items={items} date={date} onClose={() => setPreviewing(false)} />}
      {editing && (
        <ScheduleItemDialog
          editing={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(change) => {
            setEditing(undefined);
            if ("deleted" in change) removed(change.deleted);
            else saved(change.item);
            setItems(apply);
            void load();
          }}
        />
      )}
    </section>
  );
}

const itemIdOf = (item: ScheduleItemDto) => item.itemId;

function ScheduleItemDialog(props: {
  editing: Editing;
  onClose: () => void;
  /** 保存した項目か、削除した項目の ID */
  onSaved: (change: { item: ScheduleItemDto } | { deleted: string }) => void;
}) {
  const t = useT();
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
      ? t(
          `長さは ${SCHEDULE_MIN_DURATION} 分以上にしてください。`,
          `The length must be at least ${SCHEDULE_MIN_DURATION} minutes.`,
        )
      : end > DAY_MINUTES
        ? t("終わりの時刻が 24:00 を越えています。", "It ends after 24:00.")
        : undefined;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (problem) return;
    setSaving(true);
    setError(undefined);
    // 新しく作るときは押した所の列に置く。直すときは列を送らない（今の列のまま）
    const body: ScheduleItemRequest = { title, detail, startMinute, durationMinutes, column: props.editing.column };
    try {
      const res = item
        ? await api<ScheduleItemResponse>("PUT", `/admin/schedule/${item.itemId}`, body)
        : await api<ScheduleItemResponse>("POST", "/admin/schedule", body);
      props.onSaved({ item: res.item });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!item || !confirm(tr(`「${item.title}」を削除します。よろしいですか？`, `Delete “${item.title}”?`))) return;
    setSaving(true);
    try {
      await api("DELETE", `/admin/schedule/${item.itemId}`);
      props.onSaved({ deleted: item.itemId });
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <Modal
      className="dialog schedule-dialog"
      label={item ? t("項目の編集", "Edit item") : t("項目を追加", "Add item")}
      onClose={props.onClose}
      closable={!saving}
    >
      <form className="card" onSubmit={onSubmit}>
        <h2>{item ? t("項目の編集", "Edit item") : t("項目を追加", "Add item")}</h2>
        <label className="field">
          <span>{t("タイトル", "Title")}</span>
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
            <span>{t("開始", "Start")}</span>
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
          <legend>{t("長さ", "Length")}</legend>
          {DURATION_CHOICES.map((m) => (
            <button
              key={m}
              type="button"
              className={durationMinutes === m ? "on" : undefined}
              aria-pressed={durationMinutes === m}
              onClick={() => setDurationMinutes(m)}
              disabled={startMinute + m > DAY_MINUTES}
            >
              {m < 60
                ? t(`${m} 分`, `${m} min`)
                : m % 60 === 0
                  ? t(`${m / 60} 時間`, `${m / 60} h`)
                  : t(`${Math.floor(m / 60)} 時間 ${m % 60} 分`, `${Math.floor(m / 60)} h ${m % 60} min`)}
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
              aria-label={t("長さ（分）", "Length (minutes)")}
            />
            {t("分", "min")}
          </label>
        </fieldset>
        <label className="field">
          <span>{t("詳細（任意）", "Details (optional)")}</span>
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
              {t("削除", "Delete")}
            </button>
          )}
          <button type="button" onClick={props.onClose} disabled={saving}>
            {t("キャンセル", "Cancel")}
          </button>
          <button type="submit" className="primary" disabled={saving || problem !== undefined}>
            {saving ? t("保存中…", "Saving…") : t("保存", "Save")}
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
