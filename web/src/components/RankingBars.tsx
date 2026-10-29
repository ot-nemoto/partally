import type { RankingEntryDto } from "@partally/shared";

/**
 * 今のポイントの高い順に、順位・名前・ポイントと、ポイントに比例した横棒を並べる。
 * hidePoints のときはポイントの列を出さない（棒の長さだけを見せる）。
 * showStatus のときは、紐づけを解除した人を薄くして「（解除済み）」と添える（管理画面向け）
 */
export function RankingBars({
  ranking,
  hidePoints = false,
  showStatus = false,
}: {
  ranking: RankingEntryDto[];
  hidePoints?: boolean;
  showStatus?: boolean;
}) {
  // 棒の長さは 1 位のポイントを 100% とする
  const max = Math.max(0, ...ranking.map((r) => r.points));

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
            return (
              <tr key={r.userId} className={unbound ? "dimmed" : undefined}>
                <td className={`num rank-${r.rank}`}>{r.rank}</td>
                <td className="name-cell">
                  {r.displayName}
                  {unbound && "（解除済み）"}
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
