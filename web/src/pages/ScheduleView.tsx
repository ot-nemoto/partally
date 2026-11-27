import type { ScheduleResponse } from "@partally/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, errorMessage } from "../api";
import { ScheduleContent } from "../components/ScheduleTimeline";
import { useT } from "../i18n";

/** 「いま」「つぎ」を時刻に合わせて付け直す間隔 */
const TICK_MS = 30_000;

/**
 * 参加者に見せるスケジュール。管理画面と同じ時間軸に、幹事が置いた列ごとに並べ、今の時間の項目に「いま」、次の項目に「つぎ」を付け、
 * 終わった項目は薄くする（日付が決まっていれば、その日だけ）
 */
export function ScheduleView() {
  const t = useT();
  const [data, setData] = useState<ScheduleResponse>();
  const [state, setState] = useState<"loading" | "ok" | "hidden" | "error">("loading");
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => new Date());

  // 読み込みが重なったとき、後から返ってきた古い応答で戻さない
  const latestRequest = useRef(0);
  const load = useCallback(() => {
    const request = ++latestRequest.current;
    api<ScheduleResponse>("GET", "/schedule")
      .then((res) => {
        if (request !== latestRequest.current) return;
        setData(res);
        setState("ok");
      })
      .catch((e) => {
        if (request !== latestRequest.current) return;
        setState(e instanceof ApiError && e.status === 404 ? "hidden" : "error");
        setError(errorMessage(e));
      });
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  if (state === "hidden") return <p className="muted">{t("今は公開されていません。", "Not available right now.")}</p>;
  if (state === "error") return <p className="error">{error}</p>;
  if (!data) return <p className="muted">{t("読み込み中…", "Loading…")}</p>;
  return <ScheduleContent items={data.items} date={data.date} now={now} />;
}
