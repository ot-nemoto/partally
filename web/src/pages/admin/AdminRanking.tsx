import type { RankingResponse } from "@partally/shared";
import { useState } from "react";
import { PageTitle } from "../../components/PageTitle";
import { useRanking } from "../../hooks/useRanking";
import { RankingRace } from "./RankingRace";

/**
 * 今のポイントの高い順に、順位・名前・ポイントと、ポイントに比例した横棒を並べる（推移は Trend 画面）。
 * 「再生」で、順位の移り変わりを横棒のアニメーションで見せる
 */
export function AdminRanking() {
  const { data, error } = useRanking();
  /** 再生中のデータ。押した時点のものを使い、途中で「更新」しても再生を止めない */
  const [race, setRace] = useState<RankingResponse>();

  // 棒の長さは 1 位のポイントを 100% とする
  const max = Math.max(0, ...(data?.ranking.map((r) => r.points) ?? []));

  return (
    <section className="ranking">
      <PageTitle en="Ranking" ja="ランキング" />
      {error && <p className="error">{error}</p>}
      {data && data.ranking.length === 0 && <p className="muted">まだ参加者がいません。</p>}
      {race && <RankingRace data={race} onClose={() => setRace(undefined)} />}
      {!race && data && data.ranking.length > 0 && (
        <>
          <div className="race-start">
            <button type="button" onClick={() => setRace(data)}>
              ▶ 推移を再生
            </button>
          </div>
          <div className="table-wrap">
            <table className="ranking-table">
              <thead>
                <tr>
                  <th className="num">順位</th>
                  <th>名前</th>
                  <th className="num">ポイント</th>
                  <th className="ranking-bar-cell" />
                </tr>
              </thead>
              <tbody>
                {data.ranking.map((r) => (
                  <tr key={r.userId} className={r.status === "unbound" ? "dimmed" : undefined}>
                    <td className={`num rank-${r.rank}`}>{r.rank}</td>
                    <td className="name-cell">
                      {r.displayName}
                      {r.status === "unbound" && "（解除済み）"}
                    </td>
                    <td className="num">
                      <strong>{r.points}</strong>
                    </td>
                    <td className="ranking-bar-cell" aria-hidden="true">
                      <div className="ranking-bar-track">
                        {r.points > 0 && (
                          <div className="ranking-bar" style={{ width: `${(r.points / max) * 100}%` }} />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
