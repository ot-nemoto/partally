import { useEffect } from "react";

/**
 * 画面が表示されている間 intervalMs ごとに refresh を呼び、別のタブやアプリから戻ってきたときにも呼ぶ。
 * 写真の署名付き URL・Cookie には有効期限があるので、一覧を取り直して更新する。
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
