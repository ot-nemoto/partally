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
  // 差ごとの順位（並べたときに、その差が最初に出る位置）
  const rankOf = new Map<number, number>();
  [...diffs]
    .sort((a, b) => a - b)
    .forEach((diff, i) => {
      if (!rankOf.has(diff)) rankOf.set(diff, i + 1);
    });
  return diffs.map((diff) => {
    const rank = rankOf.get(diff)!;
    const range = ranks.find((r) => r.from <= rank && rank <= r.to);
    return { diff, rank, points: range?.points ?? 0 };
  });
}

/** 「1〜5 位」「3 位」のように書く */
export function formatRankRange(range: Pick<NumberRank, "from" | "to">): string {
  return range.from === range.to ? `${range.from} 位` : `${range.from}〜${range.to} 位`;
}

/** 参加者が答える形式か（クイズ・数値予想） */
export function hasGameAnswers(game: { format: string }): boolean {
  return game.format === "quiz" || game.format === "number";
}

/**
 * ゲームを確定できない理由（入るポイントが決まらない）。確定できるなら undefined。
 * 枠の無い結果入力と、正解の数か点数の範囲が無い数値予想は確定できない
 */
export function gameConfirmProblem(game: {
  format: string;
  slots: unknown[];
  ranks: unknown[];
  correctNumber?: number;
}): string | undefined {
  if (game.format === "result" && game.slots.length === 0) return "枠を追加してから確定してください";
  if (game.format === "number" && game.correctNumber === undefined) return "正解の数を入れてから確定してください";
  if (game.format === "number" && game.ranks.length === 0) return "点数の範囲を追加してから確定してください";
  return undefined;
}
