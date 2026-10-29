import type { RankingResponse } from "@partally/shared";
import { useEffect, useMemo, useState } from "react";
import { formatTime, needsDate, valueAt } from "./rankingHistory";

/** 最初に点が入る少し前から今までを再生する時間 */
const RACE_MS = 20_000;
/** 棒を出す人数 */
const RACE_ROWS = 10;
/** 1 行の高さ（px）。並び替えは行の高さぶん縦に動かして見せる */
const ROW_HEIGHT = 40;

/**
 * 順位の推移を再生するバーチャートレース。時刻を進めながら、その時点の上位を横棒で並べる。
 * 抜いた・抜かれたで行が上下に動き、最後は今のランキングと同じ並びで止まる
 */
export function RankingRace({ data, onClose }: { data: RankingResponse; onClose: () => void }) {
  const endTime = Date.parse(data.generatedAt);
  // 時刻は毎フレーム読み直さないよう、先に数にしておく
  const entries = useMemo(
    () =>
      data.ranking.map((entry) => ({
        entry,
        history: entry.history.map((h) => ({ at: Date.parse(h.at), points: h.points })),
      })),
    [data],
  );
  // 始まりは最初に点が入った時刻の少し前にする（前日に登録した人がいても、点の動かない時間を長く再生しない）。
  // まだ誰にも点がなければ最初の登録から
  const startTime = useMemo(() => {
    let firstScore = endTime;
    let firstJoin = endTime;
    for (const { history } of entries) {
      firstJoin = Math.min(firstJoin, history[0]?.at ?? endTime);
      firstScore = Math.min(firstScore, history.find((h) => h.points !== 0)?.at ?? endTime);
    }
    if (firstScore >= endTime) return firstJoin;
    return Math.max(firstJoin, firstScore - Math.max(60_000, (endTime - firstScore) * 0.05));
  }, [entries, endTime]);
  const withDate = needsDate(endTime - startTime);

  const [time, setTime] = useState(startTime);
  /** 「もう一度」で増やして再生し直す */
  const [round, setRound] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: round は再生し直すためだけに見る
  useEffect(() => {
    let frame = 0;
    const begin = performance.now();
    const tick = (now: number) => {
      const progress = Math.min((now - begin) / RACE_MS, 1);
      setTime(startTime + (endTime - startTime) * progress);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [round, startTime, endTime]);
  const done = time >= endTime;

  // その時点のポイントの高い順。同点は先に登録した人を上にする（今のランキングと同じ）。
  // 登録前の人は出さない
  const standings = entries
    .map(({ entry, history }) => ({ entry, points: valueAt(history, time), joinedAt: history[0]?.at ?? endTime }))
    .filter((s): s is typeof s & { points: number } => s.points !== undefined)
    .sort((a, b) => b.points - a.points || a.joinedAt - b.joinedAt);
  const positions = new Map<string, { index: number; rank: number; points: number }>();
  standings.forEach((s, index) => {
    const prev = standings[index - 1];
    const rank = prev && prev.points === s.points ? (positions.get(prev.entry.userId)?.rank ?? index + 1) : index + 1;
    positions.set(s.entry.userId, { index, rank, points: s.points });
  });
  // 棒の長さはその時点の 1 位を 100% にする
  const max = Math.max(1, standings[0]?.points ?? 0);
  const progress = endTime > startTime ? (time - startTime) / (endTime - startTime) : 1;

  return (
    <div className="race card">
      <div className="race-head">
        <span className="race-time">{formatTime(time, withDate)}</span>
        <div className="race-actions">
          {done ? (
            <>
              <button type="button" className="primary" onClick={() => setRound((r) => r + 1)}>
                もう一度
              </button>
              <button type="button" onClick={onClose}>
                表に戻る
              </button>
            </>
          ) : (
            <button type="button" onClick={onClose}>
              停止
            </button>
          )}
        </div>
      </div>
      <div className="race-progress" aria-hidden="true">
        <div style={{ width: `${progress * 100}%` }} />
      </div>
      {/*
        行は常に同じ順で描き、位置だけを変えて動かす（並べ替えると動きが付かない）。
        読み上げでは見た目と順番が合わないので、全体を 1 枚の絵として扱う
      */}
      <div
        className="race-board"
        style={{ height: RACE_ROWS * ROW_HEIGHT }}
        role="img"
        aria-label="順位の推移のアニメーション。終わると今のランキングと同じ並びになります"
      >
        {data.ranking.map((entry) => {
          const pos = positions.get(entry.userId);
          const shown = pos !== undefined && pos.index < RACE_ROWS;
          return (
            <div
              key={entry.userId}
              className={`race-row${entry.status === "unbound" ? " dimmed" : ""}`}
              style={{
                transform: `translateY(${Math.min(pos?.index ?? RACE_ROWS, RACE_ROWS) * ROW_HEIGHT}px)`,
                opacity: shown ? 1 : 0,
                height: ROW_HEIGHT,
              }}
            >
              <span className={`race-rank${pos && pos.rank <= 3 && entry.status !== "unbound" ? " podium" : ""}`}>
                {pos?.rank}
              </span>
              <span className="race-name" title={entry.displayName}>
                {entry.name}
              </span>
              <span className="race-track">
                {(pos?.points ?? 0) > 0 && (
                  <span className="race-bar" style={{ width: `${((pos?.points ?? 0) / max) * 100}%` }} />
                )}
              </span>
              <strong className="race-points">{pos?.points ?? 0}</strong>
            </div>
          );
        })}
      </div>
    </div>
  );
}
