import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";

interface Drag {
  pointerId: number;
  from: number;
  startY: number;
  /** ドラッグを始めたときの各行の上端と高さ（項目名が折り返して行の高さが違うことがある） */
  rows: { top: number; height: number }[];
  /** 行と行の間隔 */
  gap: number;
  dy: number;
}

/**
 * 項目を上下に並べ替えるリスト。左のつかむ所をドラッグして（マウス・指どちらでも）並べ替え、
 * キーボード・読み上げ向けに ↑↓ のボタンも置く。並べ替えるたびに onChange に新しい並びを渡す
 */
export function SortableList<T extends string>(props: {
  items: T[];
  label: (item: T) => string;
  onChange: (items: T[]) => void;
  className?: string;
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

  /**
   * ドラッグ中の行が今どの位置に入るか。下へ動かすときはつかんだ行の下端が、上へ動かすときは上端が、
   * ほかの行の中心を越えたらその行と入れ替わる
   */
  const targetOf = (d: Drag) => {
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
  };

  function onPointerDown(e: ReactPointerEvent<HTMLElement>, index: number) {
    if (e.button !== 0) return;
    const elements = listRef.current?.children;
    if (!elements || elements.length < 2) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rows = [...elements].map((el) => {
      const rect = el.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    });
    const gap = rows[1]!.top - rows[0]!.top - rows[0]!.height;
    setDrag({ pointerId: e.pointerId, from: index, startY: e.clientY, rows, gap, dy: 0 });
  }

  function onPointerMove(e: ReactPointerEvent<HTMLElement>) {
    if (drag?.pointerId !== e.pointerId) return;
    // リストの外まで行かないよう、動かせる幅を先頭の行の上端から末尾の行の下端までにする
    const first = drag.rows[0]!;
    const last = drag.rows[drag.rows.length - 1]!;
    const dragged = drag.rows[drag.from]!;
    const min = first.top - dragged.top;
    const max = last.top + last.height - dragged.height - dragged.top;
    setDrag({ ...drag, dy: Math.max(min, Math.min(max, e.clientY - drag.startY)) });
  }

  function onPointerEnd(e: ReactPointerEvent<HTMLElement>, commit: boolean) {
    if (drag?.pointerId !== e.pointerId) return;
    if (commit) move(drag.from, targetOf(drag));
    setDrag(undefined);
  }

  // ドラッグ中は、つかんだ行を指に合わせて動かし、入る位置にある行をつかんだ行の高さぶんずらして空ける
  const shiftOf = (index: number) => {
    if (!drag) return 0;
    if (index === drag.from) return drag.dy;
    const to = targetOf(drag);
    const step = drag.rows[drag.from]!.height + drag.gap;
    if (drag.from < to && index > drag.from && index <= to) return -step;
    if (drag.from > to && index < drag.from && index >= to) return step;
    return 0;
  };

  return (
    <ol
      ref={listRef}
      className={`sortable-list${drag ? " sorting" : ""}${props.className ? ` ${props.className}` : ""}`}
    >
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
