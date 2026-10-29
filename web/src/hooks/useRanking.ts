import type { RankingResponse } from "@partally/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api";
import { useOnReload } from "./useReload";

/** 管理画面の Ranking・Trend で使うランキング。画面を開いたときと「更新」で取り直す */
export function useRanking() {
  const [data, setData] = useState<RankingResponse>();
  const [error, setError] = useState<string>();

  // 「更新」を続けて押して読み込みが重なったとき、後から返ってきた古い応答で戻さない
  const latestRequest = useRef(0);
  const load = useCallback(() => {
    const request = ++latestRequest.current;
    api<RankingResponse>("GET", "/admin/ranking")
      .then((res) => {
        if (request !== latestRequest.current) return;
        setData(res);
        setError(undefined);
      })
      .catch((e) => request === latestRequest.current && setError(errorMessage(e)));
  }, []);

  useEffect(load, [load]);
  useOnReload(load);

  return { data, error };
}
