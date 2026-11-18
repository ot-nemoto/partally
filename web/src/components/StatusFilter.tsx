import { useState } from "react";
import { useT } from "../i18n";

/** 覚えた中身（JSON の配列）から出すものを決める。無い・読めないときは initial（省くと全部） */
export function initialShown<S extends string>(saved: string | null, statuses: readonly S[], initial?: readonly S[]) {
  try {
    const list = JSON.parse(saved ?? "null");
    if (Array.isArray(list)) return new Set(statuses.filter((s) => list.includes(s)));
  } catch {
    // 壊れているときは初めの状態にする
  }
  return new Set(initial ?? statuses);
}

/**
 * 一覧に出すもの（ゲームの状態・表の列など）を選ぶ切り替え（複数選べる）。どれを出すかはこのブラウザに覚える（storageKey ごと）。
 * タイトルの行に置く。initial は初めに出すもの（省くと全部）。
 * scrollToTop を省くと、切り替えたら一覧の先頭から見せる（出す行が変わるとき）。列を出し入れするときは false にして、見ている行に留まる
 */
export function useShownStatuses<S extends string>(
  storageKey: string,
  statuses: readonly S[],
  options: { initial?: readonly S[]; scrollToTop?: boolean } = {},
) {
  const [shown, setShown] = useState<Set<S>>(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(storageKey);
    } catch {
      // 読めないときは初めの状態にする
    }
    return initialShown(saved, statuses, options.initial);
  });

  function change(next: (prev: Set<S>) => Set<S>) {
    setShown((prev) => {
      const value = next(prev);
      try {
        localStorage.setItem(storageKey, JSON.stringify([...value]));
      } catch {
        // 覚えられなくても、この画面の間は切り替わる
      }
      return value;
    });
  }

  return {
    shown,
    /** 押した状態の表示・非表示を切り替える */
    toggle(status: S) {
      // 切り替えはスクロールしても画面の上に残るので、切り替えたら一覧の先頭から見せる
      if (options.scrollToTop !== false) window.scrollTo({ top: 0 });
      change((prev) => {
        const next = new Set(prev);
        if (next.has(status)) next.delete(status);
        else next.add(status);
        return next;
      });
    },
    /** 作った・状態を変えたものが、隠している状態になっても見えるようにする */
    reveal(status: S) {
      change((prev) => (prev.has(status) ? prev : new Set([...prev, status])));
    },
  };
}

/** 状態（または列）ごとの表示・非表示の切り替え（counts を渡すと件数を添える） */
export function StatusFilter<S extends string>(props: {
  statuses: readonly S[];
  labels: Record<S, string>;
  counts?: Record<S, number>;
  shown: Set<S>;
  onToggle: (status: S) => void;
}) {
  const t = useT();
  return (
    <fieldset className="status-filter">
      <legend>{t("表示", "Show")}</legend>
      {props.statuses.map((s) => (
        <button
          key={s}
          type="button"
          className={props.shown.has(s) ? "on" : undefined}
          aria-pressed={props.shown.has(s)}
          onClick={() => props.onToggle(s)}
        >
          {props.counts
            ? t(`${props.labels[s]}（${props.counts[s]}）`, `${props.labels[s]} (${props.counts[s]})`)
            : props.labels[s]}
        </button>
      ))}
    </fieldset>
  );
}
