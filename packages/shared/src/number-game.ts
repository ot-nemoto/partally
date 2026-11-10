/** 数値予想の点数の範囲（from 位〜to 位に points） */
export interface NumberRank {
  from: number;
  to: number;
  points: number;
}

export interface NumberResult {
  /** 正解との差 */
  diff: number;
  /** 順位。差が小さい順で、同じ差は同じ順位（1, 1, 3…） */
  rank: number;
  /** その順位が入る範囲の点数（どの範囲にも入らなければ 0） */
  points: number;
}

/**
 * 数値予想の答えを順位付けする。答えの順はそのままで、それぞれの差・順位・点数を返す。
 * 順位は「自分より差の小さい人の数 + 1」（同じ差の人は同じ順位で、次はその人数分飛ばす）
 */
export function rankNumberAnswers(values: number[], correct: number, ranks: NumberRank[]): NumberResult[] {
  const diffs = values.map((v) => Math.abs(v - correct));
  const sorted = [...diffs].sort((a, b) => a - b);
  return diffs.map((diff) => {
    // 自分より差の小さい人の数（sorted の中で diff が最初に出る位置）
    const rank = sorted.indexOf(diff) + 1;
    const range = ranks.find((r) => r.from <= rank && rank <= r.to);
    return { diff, rank, points: range?.points ?? 0 };
  });
}

/** 「1〜5 位」「3 位」のように書く */
export function formatRankRange(range: Pick<NumberRank, "from" | "to">): string {
  return range.from === range.to ? `${range.from} 位` : `${range.from}〜${range.to} 位`;
}
