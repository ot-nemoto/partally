import type { PrizeDto, PrizesResponse, RankingResponse } from "@partally/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { PageTitle } from "../../components/PageTitle";
import { RankingBars } from "../../components/RankingBars";
import { useRanking } from "../../hooks/useRanking";
import { useOnReload } from "../../hooks/useReload";
import { RankingRace } from "./RankingRace";

/**
 * 今のポイントの高い順に、順位・名前・ポイントと、ポイントに比例した横棒を並べる（推移は Trend 画面）。
 * 「再生」で、順位の移り変わりを横棒のアニメーションで見せる
 */
export function AdminRanking() {
  const { data, error } = useRanking();
  /** 再生中のデータ。押した時点のものを使い、途中で「更新」しても再生を止めない */
  const [race, setRace] = useState<RankingResponse>();
  // 各行にその順位の景品を添える。読めなくてもランキングは出す
  const [prizes, setPrizes] = useState<PrizeDto[]>();
  const loadPrizes = useCallback(() => {
    api<PrizesResponse>("GET", "/admin/prizes")
      .then((res) => setPrizes(res.prizes))
      .catch(() => setPrizes(undefined));
  }, []);
  useEffect(loadPrizes, [loadPrizes]);
  useOnReload(loadPrizes);

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
      {!race && data && data.ranking.length > 0 && <RankingBars ranking={data.ranking} showStatus prizes={prizes} />}
    </section>
  );
}
