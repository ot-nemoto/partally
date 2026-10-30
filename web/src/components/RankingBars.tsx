import { type PrizeDto, prizePositions, prizesByPosition, type RankingEntryDto } from "@partally/shared";
import { PrizeChips } from "./PrizeChips";

/**
 * 今のポイントの高い順に、順位・名前・ポイントと、ポイントに比例した横棒を並べる。
 * hidePoints のときはポイントの列を出さない（棒の長さだけを見せる）。
 * showStatus のときは、紐づけを解除した人を薄くして「（解除済み）」と添える（管理画面向け）。
 * prizes を渡すと、各行にその順位（上から何番目の人か）の景品を添える
 */
export function RankingBars({
  ranking,
  hidePoints = false,
  showStatus = false,
  prizes,
}: {
  ranking: RankingEntryDto[];
  hidePoints?: boolean;
  showStatus?: boolean;
  prizes?: PrizeDto[];
}) {
  // 棒の長さは 1 位のポイントを 100% とする
  const max = Math.max(0, ...ranking.map((r) => r.points));
  const positions = prizePositions(ranking);
  const byPosition = prizesByPosition(prizes ?? []);

  return (
    <div className="table-wrap">
      <table className="ranking-table">
        <thead>
          <tr>
            <th className="num">順位</th>
            <th>名前</th>
            {!hidePoints && <th className="num">ポイント</th>}
            <th className="ranking-bar-cell" />
          </tr>
        </thead>
        <tbody>
          {ranking.map((r) => {
            const unbound = showStatus && r.status === "unbound";
            const position = positions.get(r.userId);
            const rowPrizes = position === undefined ? undefined : byPosition.get(position);
            return (
              <tr key={r.userId} className={unbound ? "dimmed" : undefined}>
                <td className={`num rank-${r.rank}`}>{r.rank}</td>
                <td className="name-cell">
                  {r.displayName}
                  {unbound && "（解除済み）"}
                  {rowPrizes && <PrizeChips prizes={rowPrizes} />}
                </td>
                {!hidePoints && (
                  <td className="num">
                    <strong>{r.points}</strong>
                  </td>
                )}
                <td className="ranking-bar-cell" aria-hidden="true">
                  <div className="ranking-bar-track">
                    {r.points > 0 && <div className="ranking-bar" style={{ width: `${(r.points / max) * 100}%` }} />}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
