import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";

interface Drag {
  pointerId: number;
  from: number;
  /** つかんだときのポインタの位置（ページの先頭からの距離。ドラッグ中にスクロールしてもずれないように） */
  startY: number;
  /** ドラッグを始めたときの各行の上端（ページの先頭から）と高さ（項目名が折り返して行の高さが違うことがある） */
  rows: { top: number; height: number }[];
  /** 行と行の間隔 */
  gap: number;
  dy: number;
}

/**
 * 項目を上下に並べ替えるリスト。左のつかむ所をドラッグして（マウス・指どちらでも）並べ替え、
 * キーボード・読み上げ向けに ↑↓ のボタンも置く。並べ替えるたびに onChange に新しい並びを渡す。
 * ドラッグ中に Esc を押すと取り消す
 */
export function SortableList<T extends string>(props: {
  items: T[];
  label: (item: T) => string;
  onChange: (items: T[]) => void;
}) {
  const { items, label, onChange } = props;
  const listRef = useRef<HTMLOListElement>(null);
  const [drag, setDrag] = useState<Drag>();

  function move(from: number, to: number) {
    if (to < 0 || to >= items.length || to === from) return;
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    onChange(next);
  }

  // ドラッグ中に Esc を押したら、並びを変えずにやめる
  const dragging = drag !== undefined;
  useEffect(() => {
    if (!dragging) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrag(undefined);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dragging]);

  /** つかんだ行を、ポインタの位置に合わせてリストの先頭から末尾までの範囲で動かした量 */
  function clampedDy(d: Drag, pageY: number) {
    const first = d.rows[0]!;
    const last = d.rows[d.rows.length - 1]!;
    const dragged = d.rows[d.from]!;
    const min = first.top - dragged.top;
    const max = last.top + last.height - dragged.height - dragged.top;
    return Math.max(min, Math.min(max, pageY - d.startY));
  }

  /**
   * ドラッグ中の行が今どの位置に入るか。下へ動かすときはつかんだ行の下端が、上へ動かすときは上端が、
   * ほかの行の中心を越えたらその行と入れ替わる
   */
  function targetOf(d: Drag) {
    const dragged = d.rows[d.from]!;
    const top = dragged.top + d.dy;
    const bottom = top + dragged.height;
    let to = d.from;
    d.rows.forEach((r, j) => {
      const center = r.top + r.height / 2;
      if (j > d.from && bottom > center) to = Math.max(to, j);
      if (j < d.from && top < center) to = Math.min(to, j);
    });
    return to;
  }

  function onPointerDown(e: ReactPointerEvent<HTMLElement>, index: number) {
    // 2 本目の指などで、ドラッグ中に別の行をつかんでも横取りしない
    if (e.button !== 0 || drag) return;
    const elements = listRef.current?.children;
    if (!elements || elements.length < 2) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rows = [...elements].map((el) => {
      const rect = el.getBoundingClientRect();
      return { top: rect.top + window.scrollY, height: rect.height };
    });
    const gap = rows[1]!.top - rows[0]!.top - rows[0]!.height;
    setDrag({ pointerId: e.pointerId, from: index, startY: e.clientY + window.scrollY, rows, gap, dy: 0 });
  }

  function onPointerMove(e: ReactPointerEvent<HTMLElement>) {
    if (drag?.pointerId !== e.pointerId) return;
    setDrag({ ...drag, dy: clampedDy(drag, e.clientY + window.scrollY) });
  }

  function onPointerEnd(e: ReactPointerEvent<HTMLElement>, commit: boolean) {
    if (drag?.pointerId !== e.pointerId) return;
    // 最後の移動がまだ画面に反映されていなくても、離した位置で入る位置を決める
    if (commit) move(drag.from, targetOf({ ...drag, dy: clampedDy(drag, e.clientY + window.scrollY) }));
    setDrag(undefined);
  }

  // ドラッグ中は、つかんだ行を指に合わせて動かし、入る位置にある行をつかんだ行の高さぶんずらして空ける
  const to = drag ? targetOf(drag) : undefined;
  const shiftOf = (index: number) => {
    if (!drag || to === undefined) return 0;
    if (index === drag.from) return drag.dy;
    const step = drag.rows[drag.from]!.height + drag.gap;
    if (drag.from < to && index > drag.from && index <= to) return -step;
    if (drag.from > to && index < drag.from && index >= to) return step;
    return 0;
  };

  return (
    <ol ref={listRef} className={`sortable-list${drag ? " sorting" : ""}`}>
      {items.map((item, i) => (
        <li
          key={item}
          className={drag?.from === i ? "dragging" : undefined}
          style={drag ? { transform: `translateY(${shiftOf(i)}px)` } : undefined}
        >
          <span
            className="drag-handle"
            aria-hidden="true"
            title="ドラッグして並べ替え"
            onPointerDown={(e) => onPointerDown(e, i)}
            onPointerMove={onPointerMove}
            onPointerUp={(e) => onPointerEnd(e, true)}
            onPointerCancel={(e) => onPointerEnd(e, false)}
            // ウィンドウを切り替えたときなど、離さないままポインタを取り上げられたらやめる
            onLostPointerCapture={(e) => onPointerEnd(e, false)}
          >
            ⋮⋮
          </span>
          <span className="sortable-label">
            {i + 1}. {label(item)}
          </span>
          <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label={`${label(item)}を上へ`}>
            ↑
          </button>
          <button
            type="button"
            onClick={() => move(i, i + 1)}
            disabled={i === items.length - 1}
            aria-label={`${label(item)}を下へ`}
          >
            ↓
          </button>
        </li>
      ))}
    </ol>
  );
}
