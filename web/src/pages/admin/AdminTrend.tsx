import type { RankingEntryDto, RankingPointDto } from "@partally/shared";
import { type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { PageTitle } from "../../components/PageTitle";
import { useRanking } from "../../hooks/useRanking";

/** 色を付けて強調できる人数（色を見分けられるのは 8 色まで）。ほかの人は灰色の線で描く */
const MAX_LINES = 8;

const MARGIN = { left: 44, right: 16, top: 12, bottom: 28 };
/** これより狭いと、グラフを低くしてツールチップをグラフの下に出す */
const NARROW_WIDTH = 520;

/** 累計ポイントの推移。全員を灰色の線で描き、表で選んだ人（最大 8 人）を色付きで強調する */
export function AdminTrend() {
  const { data, error } = useRanking();
  /** グラフに出す人と色の番号（0〜7）。更新しても色は人に付いたまま変えない */
  const [slots, setSlots] = useState<Map<string, number>>();

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
                <li key={entry.userId}>
                  <span className="swatch" style={{ background: `var(--series-${slot + 1})` }} />
                  {entry.displayName}
                </li>
              ))}
              {data.ranking.length > series.length && (
                <li className="muted">
                  <span className="swatch swatch-context" />
                  その他の参加者
                </li>
              )}
            </ul>
            <RankingChart all={data.ranking} series={series} end={data.generatedAt} />
          </div>
          <p className="muted">
            色を付けて出せるのは {MAX_LINES}{" "}
            人までです（ほかの人は灰色の線）。最新にするには上の「更新」を押してください。
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
                    <tr key={r.userId} className={r.status === "unbound" ? "dimmed" : undefined}>
                      <td>
                        <label className="ranking-toggle">
                          <input
                            type="checkbox"
                            checked={slot !== undefined}
                            disabled={slot === undefined && full}
                            onChange={() => toggle(r.userId)}
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

interface Series {
  entry: RankingEntryDto;
  slot: number;
}

/**
 * 累計ポイントの階段状の折れ線。ポイントは出来事の時刻で上がるので、次の出来事までは横ばいにする。
 * 全員（all）を灰色の細い線で背景に描き、選んだ人（series）を色付きで重ねる。軸の範囲は全員から決める
 */
function RankingChart({ all, series, end }: { all: RankingEntryDto[]; series: Series[]; end: string }) {
  const [hover, setHover] = useState<number>();
  // 文字の大きさを保つため、viewBox で拡大縮小せず表示幅に合わせて描く
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => entry && setWidth(Math.max(entry.contentRect.width, 280)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const narrow = width < NARROW_WIDTH;
  const CHART = { ...MARGIN, width, height: narrow ? 240 : 320 };

  const endTime = Date.parse(end);
  // 軸の範囲は全員から決める。人数や出来事が多くても引数の上限に当たらないよう、展開せずに数える
  const { startTime, maxPoints } = useMemo(() => {
    let start = endTime;
    let max = 0;
    for (const e of all) {
      start = Math.min(start, Date.parse(e.history[0]?.at ?? end));
      max = Math.max(max, e.points);
      for (const h of e.history) max = Math.max(max, h.points);
    }
    return { startTime: start, maxPoints: niceMax(max) };
  }, [all, end, endTime]);
  const span = Math.max(endTime - startTime, 60_000);

  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const x = (time: number) => CHART.left + ((time - startTime) / span) * plotWidth;
  const y = (points: number) => CHART.top + plotHeight - (points / maxPoints) * plotHeight;

  // 灰色の線はホバーでは変わらないので、データ・選択・大きさが変わったときだけ作り直す
  const chartHeight = CHART.height;
  const contextPaths = useMemo(() => {
    const selected = new Set(series.map((s) => s.entry.userId));
    const plotH = chartHeight - MARGIN.top - MARGIN.bottom;
    const toX = (time: number) => MARGIN.left + ((time - startTime) / span) * (width - MARGIN.left - MARGIN.right);
    const toY = (points: number) => MARGIN.top + plotH - (points / maxPoints) * plotH;
    return all
      .filter((e) => !selected.has(e.userId))
      .map((e) => <path key={e.userId} className="series-line context" d={stepPath(e.history, toX, toY)} />);
  }, [all, series, startTime, span, maxPoints, width, chartHeight]);

  const yTicks = Array.from({ length: 5 }, (_, i) => (maxPoints / 4) * i);
  const xTickCount = narrow ? 3 : 5;
  const xTicks = Array.from({ length: xTickCount }, (_, i) => startTime + (span / (xTickCount - 1)) * i);
  const withDate = span > 20 * 60 * 60 * 1000;

  function onPointerMove(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * CHART.width;
    const time = startTime + ((px - CHART.left) / plotWidth) * span;
    setHover(Math.min(Math.max(time, startTime), endTime));
  }

  const hoverValues =
    hover === undefined
      ? []
      : series
          .map((s) => ({ ...s, points: valueAt(s.entry.history, hover) }))
          .filter((s): s is Series & { points: number } => s.points !== undefined)
          .sort((a, b) => b.points - a.points);
  const hoverLeft = hover === undefined ? 0 : (x(hover) / CHART.width) * 100;

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg
        width={CHART.width}
        height={CHART.height}
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        role="img"
        aria-label="累計ポイントの推移"
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(undefined)}
      >
        {yTicks.map((tick) => (
          <g key={tick}>
            <line className="grid" x1={CHART.left} x2={CHART.width - CHART.right} y1={y(tick)} y2={y(tick)} />
            <text className="tick" x={CHART.left - 6} y={y(tick)} textAnchor="end" dominantBaseline="middle">
              {formatPoints(tick)}
            </text>
          </g>
        ))}
        {xTicks.map((tick, i) => (
          <text
            key={tick}
            className="tick"
            x={x(tick)}
            y={CHART.height - 8}
            textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
          >
            {formatTime(tick, withDate)}
          </text>
        ))}
        {/* 透明度はまとめて付ける（線ごとに付けると重なった所が濃くなる） */}
        <g className="context-lines">{contextPaths}</g>
        {series.map(({ entry, slot }) => (
          <path
            key={entry.userId}
            className="series-line"
            d={stepPath(entry.history, x, y)}
            stroke={`var(--series-${slot + 1})`}
          />
        ))}
        {hover !== undefined && series.length > 0 && (
          <g>
            <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={CHART.top} y2={CHART.top + plotHeight} />
            {hoverValues.map((s) => (
              <circle
                key={s.entry.userId}
                className="marker"
                cx={x(hover)}
                cy={y(s.points)}
                r={4}
                fill={`var(--series-${s.slot + 1})`}
              />
            ))}
          </g>
        )}
      </svg>
      {hover !== undefined && hoverValues.length > 0 && (
        <div
          className={`chart-tooltip${narrow ? " below" : hoverLeft > 60 ? " left" : ""}`}
          style={narrow ? undefined : { left: `${hoverLeft}%` }}
          aria-hidden="true"
        >
          <div className="muted">{formatTime(hover, withDate)}</div>
          {hoverValues.map((s) => (
            <div key={s.entry.userId} className="row">
              <span className="swatch" style={{ background: `var(--series-${s.slot + 1})` }} />
              <span className="tooltip-name">{s.entry.displayName}</span>
              <strong>{s.points}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function stepPath(history: RankingPointDto[], x: (t: number) => number, y: (p: number) => number) {
  return history
    .map((h, i) => {
      const px = x(Date.parse(h.at)).toFixed(1);
      const py = y(h.points).toFixed(1);
      return i === 0 ? `M${px},${py}` : `H${px}V${py}`;
    })
    .join("");
}

/** time の時点の累計。登録前なら undefined */
function valueAt(history: RankingPointDto[], time: number) {
  let value: number | undefined;
  for (const h of history) {
    if (Date.parse(h.at) > time) break;
    value = h.points;
  }
  return value;
}

/** 目盛りが切りのよい数になる上限（4 等分する） */
function niceMax(max: number) {
  if (max <= 4) return 4;
  const step = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(step));
  // 目盛りが整数になる刻みだけを使う（2.5 刻みは 25, 250… のときだけ）
  const nice =
    [1, 2, 2.5, 5, 10]
      .map((m) => m * magnitude)
      .filter(Number.isInteger)
      .find((s) => s >= step) ?? step;
  return nice * 4;
}

function formatPoints(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatTime(time: number, withDate: boolean) {
  const d = new Date(time);
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  return withDate ? `${d.getMonth() + 1}/${d.getDate()} ${hm}` : hm;
}
