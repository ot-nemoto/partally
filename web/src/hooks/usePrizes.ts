import type { PrizeDto, PrizesResponse } from "@partally/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import { useOnReload } from "./useReload";

export type PrizesState = "loading" | "ok" | "hidden" | "error";

/**
 * 景品の一覧。画面を開いたときと「更新」で取り直す。path は管理画面なら /admin/prizes、参加者なら /prizes。
 * enabled が false の間は読まず、持っている景品も消す。404（参加者に見せない設定）は hidden にする
 */
export function usePrizes(path: "/admin/prizes" | "/prizes", enabled = true) {
  const [prizes, setPrizes] = useState<PrizeDto[]>();
  const [state, setState] = useState<PrizesState>("loading");

  // 「更新」を続けて押して読み込みが重なったとき、後から返ってきた古い応答で戻さない
  const latestRequest = useRef(0);
  const load = useCallback(() => {
    const request = ++latestRequest.current;
    if (!enabled) {
      setPrizes(undefined);
      setState("hidden");
      return;
    }
    api<PrizesResponse>("GET", path)
      .then((res) => {
        if (request !== latestRequest.current) return;
        setPrizes(res.prizes);
        setState("ok");
      })
      .catch((e) => {
        if (request !== latestRequest.current) return;
        setPrizes(undefined);
        setState(e instanceof ApiError && e.status === 404 ? "hidden" : "error");
      });
  }, [path, enabled]);
  useEffect(load, [load]);
  useOnReload(load);

  return { prizes, state };
}
