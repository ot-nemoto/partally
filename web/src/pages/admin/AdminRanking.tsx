import type { RankingResponse } from "@partally/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../api";
import { PageTitle } from "../../components/PageTitle";
import { useOnReload } from "../../hooks/useReload";

/** 今のポイントの高い順に、順位・名前・ポイントと、ポイントに比例した横棒を並べる（推移は Trend 画面） */
export function AdminRanking() {
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

  // 棒の長さは 1 位のポイントを 100% とする
  const max = Math.max(0, ...(data?.ranking.map((r) => r.points) ?? []));

  return (
    <section className="ranking">
      <PageTitle en="Ranking" ja="ランキング" />
      {error && <p className="error">{error}</p>}
      {data && data.ranking.length === 0 && <p className="muted">まだ参加者がいません。</p>}
      {data && data.ranking.length > 0 && (
        <div className="table-wrap">
          <table className="ranking-table">
            <thead>
              <tr>
                <th className="num">順位</th>
                <th>名前</th>
                <th className="num">ポイント</th>
                <th className="ranking-bar-cell" aria-label="ポイントのグラフ" />
              </tr>
            </thead>
            <tbody>
              {data.ranking.map((r) => (
                <tr key={r.userId} className={r.status === "unbound" ? "dimmed" : undefined}>
                  <td className={`num rank rank-${r.rank}`}>{r.rank}</td>
                  <td className="name-cell">
                    {r.displayName}
                    {r.status === "unbound" && "（解除済み）"}
                  </td>
                  <td className="num">
                    <strong>{r.points}</strong>
                  </td>
                  <td className="ranking-bar-cell" aria-hidden="true">
                    <div className="ranking-bar-track">
                      {r.points > 0 && <div className="ranking-bar" style={{ width: `${(r.points / max) * 100}%` }} />}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
