import { type RefObject, useEffect } from "react";

/**
 * 要素の高さを測り、ページ全体の CSS 変数（name）にする。固定した行の下にさらに行を固定するときに、その位置合わせに使う。
 * 拡大表示でもすき間ができないよう、高さは小数まで渡す。外したとき（enabled が false・アンマウント）は変数を消す
 */
export function useHeightVar(ref: RefObject<HTMLElement | null>, name: string, enabled = true) {
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => root.style.setProperty(name, `${el.getBoundingClientRect().height}px`));
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty(name);
    };
  }, [ref, name, enabled]);
}
