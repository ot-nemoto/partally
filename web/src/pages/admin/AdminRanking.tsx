import type { RankingEntryDto, RankingPointDto, RankingResponse } from "@partally/shared";
import { type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../api";
import { useAutoRefresh } from "../../hooks/useAutoRefresh";

const REFRESH_MS = 30_000;
/** グラフに同時に出せる人数（色を見分けられるのは 8 色まで） */
const MAX_LINES = 8;

const MARGIN = { left: 44, right: 16, top: 12, bottom: 28 };
/** これより狭いと、グラフを低くしてツールチップをグラフの下に出す */
const NARROW_WIDTH = 520;

export function AdminRanking() {
  const [data, setData] = useState<RankingResponse>();
  const [error, setError] = useState<string>();
  /** グラフに出す人と色の番号（0〜7）。更新しても色は人に付いたまま変えない */
  const [slots, setSlots] = useState<Map<string, number>>();

  // 定期更新と画面への復帰で読み込みが重なったとき、後から返ってきた古い応答で戻さない
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
  useAutoRefresh(load, REFRESH_MS);

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
      <h1>ランキング</h1>
      {error && <p className="error">{error}</p>}
      {data && data.ranking.length === 0 && <p className="muted">まだ参加者がいません。</p>}
      {data && data.ranking.length > 0 && (
        <>
          <div className="card ranking-chart">
            <h2>累計ポイントの推移</h2>
            {series.length === 0 ? (
              <p className="muted">下の表でグラフに出す人を選んでください。</p>
            ) : (
              <>
                <ul className="ranking-legend">
                  {series.map(({ entry, slot }) => (
                    <li key={entry.userId}>
                      <span className="swatch" style={{ background: `var(--series-${slot + 1})` }} />
                      {entry.displayName}
                    </li>
                  ))}
                </ul>
                <RankingChart series={series} end={data.generatedAt} />
              </>
            )}
          </div>
          <p className="muted">
            グラフに出せるのは {MAX_LINES} 人までです。{REFRESH_MS / 1000} 秒ごとに更新します。
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>グラフ</th>
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
                            aria-label={`${r.displayName} をグラフに出す`}
                          />
                          <span
                            className="swatch"
                            style={{ background: slot === undefined ? "transparent" : `var(--series-${slot + 1})` }}
                          />
                        </label>
                      </td>
                      <td className="num">{r.rank}</td>
                      <td>
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

/** 累計ポイントの階段状の折れ線。ポイントは出来事の時刻で上がるので、次の出来事までは横ばいにする */
function RankingChart({ series, end }: { series: Series[]; end: string }) {
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
  const startTime = Math.min(...series.map((s) => Date.parse(s.entry.history[0]?.at ?? end)));
  const span = Math.max(endTime - startTime, 60_000);
  const maxPoints = niceMax(Math.max(...series.map((s) => s.entry.points), ...series.flatMap(historyPoints)));

  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const x = (time: number) => CHART.left + ((time - startTime) / span) * plotWidth;
  const y = (points: number) => CHART.top + plotHeight - (points / maxPoints) * plotHeight;

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
        {series.map(({ entry, slot }) => (
          <path
            key={entry.userId}
            className="series-line"
            d={stepPath(entry.history, x, y)}
            stroke={`var(--series-${slot + 1})`}
          />
        ))}
        {hover !== undefined && (
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

function historyPoints(s: Series) {
  return s.entry.history.map((h) => h.points);
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
  const nice = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= step) ?? step;
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
