import type { RankingResponse } from "@partally/shared";
import { useState } from "react";
import { PageTitle } from "../../components/PageTitle";
import { RankingBars } from "../../components/RankingBars";
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

  return (
    <section className="ranking">
      <PageTitle en="Ranking" ja="ランキング">
        {!race && data && data.ranking.length > 0 && (
          <button type="button" onClick={() => setRace(data)}>
            ▶ 推移を再生
          </button>
        )}
      </PageTitle>
      {error && <p className="error">{error}</p>}
      {data && data.ranking.length === 0 && <p className="muted">まだ参加者がいません。</p>}
      {race && <RankingRace data={race} onClose={() => setRace(undefined)} />}
      {!race && data && data.ranking.length > 0 && <RankingBars ranking={data.ranking} showStatus />}
    </section>
  );
}
