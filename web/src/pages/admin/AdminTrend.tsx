import type { RankingEntryDto, RankingPointDto } from "@partally/shared";
import { type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { PageTitle } from "../../components/PageTitle";
import { useRanking } from "../../hooks/useRanking";

/** 色を付けて強調できる人数（色だけで見分けられるのは 10 色ほどまで）。ほかの人は灰色の線で描く */
const MAX_LINES = 10;

/** 右側は線の終わりに名前を出すぶん空ける */
const MARGIN = { left: 44, right: 108, top: 12, bottom: 28 };
/** 狭い画面での右の余白と、名前を省略せずに出す文字数 */
const NARROW_RIGHT = 68;
const LABEL_CHARS = { wide: 7, narrow: 4 };
/** 名前と名前の縦の間隔（px）。これより近いときは上下にずらす */
const LABEL_GAP = 13;
/** これより狭いと、グラフを低くしてツールチップをグラフの下に出す */
const NARROW_WIDTH = 520;

/**
 * 累計ポイントの推移。全員を灰色の線で描き、表で選んだ人（最大 10 人）を色付きで強調する。
 * 表の行や凡例にカーソルを合わせた人は、線を太くするか（灰色の人なら）濃い色で重ねる
 */
export function AdminTrend() {
  const { data, error } = useRanking();
  /** グラフに出す人と色の番号（0〜9）。更新しても色は人に付いたまま変えない */
  const [slots, setSlots] = useState<Map<string, number>>();
  /** カーソルを合わせている人 */
  const [focus, setFocus] = useState<string>();

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
                <li
                  key={entry.userId}
                  onPointerEnter={() => setFocus(entry.userId)}
                  onPointerLeave={() => setFocus(undefined)}
                >
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
                      onPointerEnter={() => setFocus(r.userId)}
                      onPointerLeave={() => setFocus(undefined)}
                    >
                      <td>
                        <label className="ranking-toggle">
                          <input
                            type="checkbox"
                            checked={slot !== undefined}
                            disabled={slot === undefined && full}
                            onChange={() => toggle(r.userId)}
                            onFocus={() => setFocus(r.userId)}
                            onBlur={() => setFocus(undefined)}
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

/** 色付きで描く線（選んだ人と、カーソルを合わせた灰色の人） */
interface Line {
  entry: RankingEntryDto;
  color: string;
  focused: boolean;
}

/**
 * 累計ポイントの階段状の折れ線。ポイントは出来事の時刻で上がるので、次の出来事までは横ばいにする。
 * 全員（all）を灰色の細い線で背景に描き、選んだ人（series）を色付きで重ねて、右端に名前を出す。
 * focus の人は線を太くし、灰色の人なら濃い色で重ねる。軸の範囲は全員から決める
 */
function RankingChart({
  all,
  series,
  focus,
  end,
}: {
  all: RankingEntryDto[];
  series: Series[];
  focus: string | undefined;
  end: string;
}) {
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
  const CHART = { ...MARGIN, right: narrow ? NARROW_RIGHT : MARGIN.right, width, height: narrow ? 240 : 320 };

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
  const chartRight = CHART.right;
  const contextPaths = useMemo(() => {
    const selected = new Set(series.map((s) => s.entry.userId));
    const plotH = chartHeight - MARGIN.top - MARGIN.bottom;
    const toX = (time: number) => MARGIN.left + ((time - startTime) / span) * (width - MARGIN.left - chartRight);
    const toY = (points: number) => MARGIN.top + plotH - (points / maxPoints) * plotH;
    return all
      .filter((e) => !selected.has(e.userId))
      .map((e) => <path key={e.userId} className="series-line context" d={stepPath(e.history, toX, toY)} />);
  }, [all, series, startTime, span, maxPoints, width, chartHeight, chartRight]);

  // 色付きの線。強調する線は最後に描いて上に重ねる
  const lines: Line[] = series.map(({ entry, slot }) => ({
    entry,
    color: `var(--series-${slot + 1})`,
    focused: entry.userId === focus,
  }));
  const focusedContext = focus !== undefined && !lines.some((l) => l.focused) && all.find((e) => e.userId === focus);
  if (focusedContext) lines.push({ entry: focusedContext, color: "var(--text)", focused: true });
  lines.sort((a, b) => Number(a.focused) - Number(b.focused));

  // 右端の名前。線の終わりの高さに置き、近いものは上下にずらす
  const plotRight = CHART.width - CHART.right;
  const labels = placeLabels(
    lines.map((l) => ({ ...l, lineY: y(l.entry.points) })),
    CHART.top,
    CHART.top + plotHeight,
  );
  const labelChars = narrow ? LABEL_CHARS.narrow : LABEL_CHARS.wide;

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
      : lines
          .map((l) => ({ ...l, points: valueAt(l.entry.history, hover) }))
          .filter((l): l is Line & { points: number } => l.points !== undefined)
          .sort((a, b) => b.points - a.points);
  const hoverLeft = hover === undefined ? 0 : (x(hover) / CHART.width) * 100;

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg
        width={CHART.width}
        height={CHART.height}
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        className={focus !== undefined ? "has-focus" : undefined}
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
        {lines.map((l) => (
          <path
            key={l.entry.userId}
            className={`series-line${l.focused ? " focused" : ""}`}
            d={stepPath(l.entry.history, x, y)}
            stroke={l.color}
          />
        ))}
        {labels.map((l) => (
          <g key={l.entry.userId} className={`end-label${l.focused ? " focused" : ""}`}>
            <title>{l.entry.displayName}</title>
            {/* ずらした名前と線の終わりを細い灰色の線でつなぐ（色付きだと点が急に増えたように見える） */}
            <line className="leader" x1={plotRight + 3} y1={l.lineY} x2={plotRight + 10} y2={l.labelY} />
            <rect x={plotRight + 12} y={l.labelY - 4} width={8} height={8} rx={2} fill={l.color} />
            <text x={plotRight + 23} y={l.labelY} dominantBaseline="middle">
              {shorten(l.entry.name, labelChars)}
            </text>
          </g>
        ))}
        {hover !== undefined && lines.length > 0 && (
          <g>
            <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={CHART.top} y2={CHART.top + plotHeight} />
            {hoverValues.map((s) => (
              <circle key={s.entry.userId} className="marker" cx={x(hover)} cy={y(s.points)} r={4} fill={s.color} />
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
              <span className="swatch" style={{ background: s.color }} />
              <span className="tooltip-name">{s.entry.displayName}</span>
              <strong>{s.points}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 名前の縦の位置を決める。線の終わりの高さ（lineY）の順に並べ、LABEL_GAP より近ければ下へずらし、
 * 下にはみ出したぶんは下から上へ押し戻す
 */
function placeLabels<T extends { lineY: number }>(items: T[], top: number, bottom: number) {
  const sorted = [...items].sort((a, b) => a.lineY - b.lineY).map((item) => ({ ...item, labelY: item.lineY }));
  for (let i = 0; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const item = sorted[i];
    if (item) item.labelY = Math.max(item.labelY, prev ? prev.labelY + LABEL_GAP : top);
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const next = sorted[i + 1];
    const item = sorted[i];
    if (item) item.labelY = Math.min(item.labelY, next ? next.labelY - LABEL_GAP : bottom);
  }
  return sorted;
}

/** max 文字を超える名前は末尾を「…」にする */
function shorten(name: string, max: number) {
  const chars = [...name];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : name;
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
