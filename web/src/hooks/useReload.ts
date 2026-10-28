import { createContext, useContext, useEffect, useRef } from "react";

/** 「更新」ボタンが押された回数。画面はこの値が変わったときだけ取り直す（自動では取り直さない） */
const ReloadContext = createContext(0);

export const ReloadProvider = ReloadContext.Provider;

/** 「更新」ボタンが押されたら reload を呼ぶ。開いたときの最初の読み込みは各画面で行う */
export function useOnReload(reload: () => void) {
  const count = useContext(ReloadContext);
  const latest = useRef(reload);
  useEffect(() => {
    latest.current = reload;
  }, [reload]);
  // 画面を開いた時点の回数では呼ばない（最初の読み込みと重ならないように）
  const openedAt = useRef(count);
  useEffect(() => {
    if (count !== openedAt.current) latest.current();
  }, [count]);
}
