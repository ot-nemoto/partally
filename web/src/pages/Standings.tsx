import type { ParticipantRankingResponse } from "@partally/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, errorMessage } from "../api";
import { useParticipant } from "../components/ParticipantLayout";
import { RankingBars } from "../components/RankingBars";
import { MAX_LINES, RankingChart } from "../components/RankingChart";
import { useOnReload } from "../hooks/useReload";

type View = "ranking" | "trend";

/**
 * 参加者のランキング・ポイントの推移。どちらを見せるか、名前・ポイントを伏せるかは管理画面の設定に従う
 * （伏せる分は API から返らない）。両方見せるときは切り替えて表示する
 */
export function Standings() {
  const { rules } = useParticipant();
  const views = (["ranking", "trend"] as const).filter((v) =>
    v === "ranking" ? rules.rankingVisible : rules.trendVisible,
  );
  const [selected, setSelected] = useState<View>();
  const view = selected && views.includes(selected) ? selected : views[0];

  return (
    <section className="ranking">
      <h1>順位</h1>
      {views.length > 1 && (
        <div className="segmented" role="tablist">
          {views.map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              className={view === v ? "active" : undefined}
              onClick={() => setSelected(v)}
            >
              {v === "ranking" ? "ランキング" : "ポイントの推移"}
            </button>
          ))}
        </div>
      )}
      {view ? <StandingsView key={view} view={view} /> : <p className="muted">今は公開されていません。</p>}
    </section>
  );
}

function StandingsView({ view }: { view: View }) {
  const [data, setData] = useState<ParticipantRankingResponse>();
  const [error, setError] = useState<string>();
  const [hidden, setHidden] = useState(false);

  // 「更新」を続けて押したとき、後から返ってきた古い応答で戻さない
  const latestRequest = useRef(0);
  const load = useCallback(() => {
    const request = ++latestRequest.current;
    api<ParticipantRankingResponse>("GET", `/${view}`)
      .then((res) => {
        if (request !== latestRequest.current) return;
        setData(res);
        setHidden(false);
        setError(undefined);
      })
      .catch((e) => {
        if (request !== latestRequest.current) return;
        // 見ている間に非公開にされた
        const notPublic = e instanceof ApiError && e.status === 404;
        setHidden(notPublic);
        setError(notPublic ? undefined : errorMessage(e));
      });
  }, [view]);
  useEffect(load, [load]);
  useOnReload(load);

  // 推移は上位の人を色付きにし、ほかは灰色の線で出す
  const series = useMemo(
    () => (data?.ranking ?? []).slice(0, MAX_LINES).map((entry, slot) => ({ entry, slot })),
    [data],
  );

  if (hidden) return <p className="muted">今は公開されていません。</p>;
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">読み込み中…</p>;
  if (data.ranking.length === 0) return <p className="muted">まだ参加者がいません。</p>;

  return (
    <>
      {view === "ranking" ? (
        <RankingBars ranking={data.ranking} hidePoints={data.hidePoints} />
      ) : (
        <div className="card ranking-chart">
          <h2>累計ポイントの推移</h2>
          <p className="muted small">上位 {Math.min(MAX_LINES, data.ranking.length)} 人を色付きで表示しています。</p>
          <RankingChart all={data.ranking} series={series} end={data.generatedAt} hidePoints={data.hidePoints} />
        </div>
      )}
      <p className="muted small">最新にするには下の「更新」を押してください。</p>
    </>
  );
}
