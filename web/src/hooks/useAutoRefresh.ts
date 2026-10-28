import { useEffect } from "react";

/**
 * 画面が表示されている間 intervalMs ごとに refresh を呼び、別のタブやアプリから戻ってきたときにも呼ぶ。
 * 画面が見えていない間は呼ばない。自動で取り直すのは出題中のクイズだけ（それ以外は「更新」ボタンで取り直す）
 */
export function useAutoRefresh(refresh: () => void, intervalMs: number) {
  useEffect(() => {
    const timer = setInterval(() => document.visibilityState === "visible" && refresh(), intervalMs);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, intervalMs]);
}
