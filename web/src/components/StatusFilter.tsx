import { useState } from "react";

/**
 * 一覧に出す状態を選ぶ切り替え（複数選べる）。どれを出すかはこのブラウザに覚える（storageKey ごと）。
 * タイトルの行に置き、切り替えたら一覧の先頭から見せる
 */
export function useShownStatuses<S extends string>(storageKey: string, statuses: readonly S[]) {
  const [shown, setShown] = useState<Set<S>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (Array.isArray(saved)) return new Set(statuses.filter((s) => saved.includes(s)));
    } catch {
      // 読めない・壊れているときは全部出す
    }
    return new Set(statuses);
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
      window.scrollTo({ top: 0 });
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

/** 状態ごとの表示・非表示の切り替え（件数つき） */
export function StatusFilter<S extends string>(props: {
  statuses: readonly S[];
  labels: Record<S, string>;
  counts: Record<S, number>;
  shown: Set<S>;
  onToggle: (status: S) => void;
}) {
  return (
    <fieldset className="status-filter">
      <legend>表示</legend>
      {props.statuses.map((s) => (
        <button
          key={s}
          type="button"
          className={props.shown.has(s) ? "on" : undefined}
          aria-pressed={props.shown.has(s)}
          onClick={() => props.onToggle(s)}
        >
          {props.labels[s]}（{props.counts[s]}）
        </button>
      ))}
    </fieldset>
  );
}
