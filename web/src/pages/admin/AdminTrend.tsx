import { type PointerEvent, useEffect, useMemo, useState } from "react";
import { PageTitle } from "../../components/PageTitle";
import { MAX_LINES, RankingChart } from "../../components/RankingChart";
import { useRanking } from "../../hooks/useRanking";

/**
 * 累計ポイントの推移。全員を灰色の線で描き、表で選んだ人（最大 10 人）を色付きで強調する。
 * 表の行や凡例にカーソルを合わせた人は、線を太くするか（灰色の人なら）濃い色で重ねる
 */
export function AdminTrend() {
  const { data, error } = useRanking();
  /** グラフに出す人と色の番号（0〜9）。更新しても色は人に付いたまま変えない */
  const [slots, setSlots] = useState<Map<string, number>>();
  /**
   * 強調する人。マウスを合わせている人を優先し、なければキーボードでチェックボックスに移った人。
   * タッチでは触れた直後に pointerleave が来て一瞬で消えるので、マウスだけを見る
   */
  const [pointerFocus, setPointerFocus] = useState<string>();
  const [keyFocus, setKeyFocus] = useState<string>();
  const focus = pointerFocus ?? keyFocus;
  const hoverProps = (userId: string) => ({
    onPointerEnter: (e: PointerEvent) => e.pointerType === "mouse" && setPointerFocus(userId),
    onPointerLeave: () => setPointerFocus(undefined),
  });

  // 参加者がいる最初の読み込みで上位をグラフに出す。以降は選んだ人を保ち、いなくなった人だけ外す
  useEffect(() => {
    if (!data) return;
    setSlots((prev) => {
      if (!prev) {
        if (data.ranking.length === 0) return undefined;
        return new Map(data.ranking.slice(0, MAX_LINES).map((r, i) => [r.userId, i]));
      }
      const ids = new Set(data.ranking.map((r) => r.userId));
      const kept = [...prev].filter(([userId]) => ids.has(userId));
      return kept.length === prev.size ? prev : new Map(kept);
    });
  }, [data]);

  function toggle(userId: string) {
    setSlots((prev) => {
      const next = new Map(prev);
      if (next.has(userId)) {
        next.delete(userId);
        // 外した直後に、合わせたままのカーソルで濃い色の線として出し直さない
        setPointerFocus(undefined);
      } else {
        const used = new Set(next.values());
        const free = Array.from({ length: MAX_LINES }, (_, i) => i).find((i) => !used.has(i));
        if (free === undefined) return prev;
        next.set(userId, free);
      }
      return next;
    });
  }

  const series = useMemo(
    () =>
      (data?.ranking ?? [])
        .filter((r) => slots?.has(r.userId))
        .map((r) => ({ entry: r, slot: slots?.get(r.userId) ?? 0 })),
    [data, slots],
  );
  const full = (slots?.size ?? 0) >= MAX_LINES;

  return (
    <section className="ranking">
      <PageTitle en="Trend" ja="ポイントの推移" />
      {error && <p className="error">{error}</p>}
      {data && data.ranking.length === 0 && <p className="muted">まだ参加者がいません。</p>}
      {data && data.ranking.length > 0 && (
        <>
          <div className="card ranking-chart">
            <h2>累計ポイントの推移</h2>
            <ul className="ranking-legend">
              {series.map(({ entry, slot }) => (
                <li key={entry.userId} {...hoverProps(entry.userId)}>
                  <span className="swatch" style={{ background: `var(--series-${slot + 1})` }} />
                  {entry.displayName}
                </li>
              ))}
            </ul>
            <RankingChart all={data.ranking} series={series} focus={focus} end={data.generatedAt} />
          </div>
          <p className="muted">
            色を付けて出せるのは {MAX_LINES}{" "}
            人までです（ほかの人は灰色の線）。行にカーソルを合わせると、その人の線を強調します。最新にするには上の「更新」を押してください。
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>強調</th>
                  <th className="num">順位</th>
                  <th>名前</th>
                  <th className="num">ポイント</th>
                </tr>
              </thead>
              <tbody>
                {data.ranking.map((r) => {
                  const slot = slots?.get(r.userId);
                  return (
                    <tr
                      key={r.userId}
                      className={r.status === "unbound" ? "dimmed" : undefined}
                      {...hoverProps(r.userId)}
                    >
                      <td>
                        <label className="ranking-toggle">
                          <input
                            type="checkbox"
                            checked={slot !== undefined}
                            disabled={slot === undefined && full}
                            onChange={() => toggle(r.userId)}
                            onFocus={(e) => e.currentTarget.matches(":focus-visible") && setKeyFocus(r.userId)}
                            onBlur={() => setKeyFocus(undefined)}
                            aria-label={`${r.displayName} をグラフで色付きにする`}
                          />
                          <span
                            className="swatch"
                            style={{ background: slot === undefined ? "transparent" : `var(--series-${slot + 1})` }}
                          />
                        </label>
                      </td>
                      <td className="num">{r.rank}</td>
                      <td className="name-cell">
                        {r.displayName}
                        {r.status === "unbound" && "（解除済み）"}
                      </td>
                      <td className="num">
                        <strong>{r.points}</strong>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
