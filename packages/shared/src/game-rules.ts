/**
 * ゲームの決まり（形式によらない部分と、形式ごとの集計）。API と画面の両方で使う。
 * 数値予想の順位付け・投票の集計・合言葉の比べ方・抽選の並べ替え・確定の条件など
 */
/** 数値予想・投票の点数の範囲（from 位〜to 位に points） */
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

/** 順位（番目・等）が入る範囲。どの範囲にも入らなければ undefined */
export function rankRangeOf<T extends Pick<NumberRank, "from" | "to">>(
  ranks: readonly T[],
  rank: number,
): T | undefined {
  return ranks.find((r) => r.from <= rank && rank <= r.to);
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
    return { diff, rank, points: rankRangeOf(ranks, rank)?.points ?? 0 };
  });
}

/** 投票で選ばれた人ごとの票数・順位・点数 */
export interface VoteResult {
  userId: string;
  votes: number;
  /** 順位。票の多い順で、同じ票数は同じ順位（1, 1, 3…） */
  rank: number;
  /** その順位が入る範囲の点数（どの範囲にも入らなければ 0） */
  points: number;
}

/**
 * 投票を数える。票を集めた人（0 票の人は含めない）を票の多い順に、順位と点数を付けて返す。
 * 順位は「自分より票の多い人の数 + 1」。同じ票数の人は userId の順に並べる
 */
export function tallyVotes(targetUserIds: string[], ranks: NumberRank[]): VoteResult[] {
  const counts = new Map<string, number>();
  for (const id of targetUserIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const sorted = [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  let rank = 0;
  return sorted.map(([userId, votes], i) => {
    if (i === 0 || sorted[i - 1]![1] !== votes) rank = i + 1;
    return { userId, votes, rank, points: rankRangeOf(ranks, rank)?.points ?? 0 };
  });
}

/** 順位の単位（合言葉は正解した順なので「番目」、抽選は「等」） */
export function rankUnit(format: string): string {
  return format === "keyword" ? "番目" : format === "lottery" ? "等" : "位";
}

/** 「1〜5 位」「3 位」のように書く */
export function formatRankRange(range: Pick<NumberRank, "from" | "to">, unit = "位"): string {
  return range.from === range.to ? `${range.from} ${unit}` : `${range.from}〜${range.to} ${unit}`;
}

/** 参加者が答える形式か（結果入力のほか全部） */
export function hasGameAnswers(game: { format: string }): boolean {
  return game.format !== "result";
}

/** 順位の範囲で点数を決める形式か（数値予想・投票・合言葉・抽選） */
export function hasGameRanks(game: { format: string }): boolean {
  return ["number", "vote", "keyword", "lottery"].includes(game.format);
}

/**
 * 合言葉を比べる形にする。全角・半角、大文字・小文字、カタカナ・ひらがな、空白の違いをなくす
 * （「パーティー」「ぱーてぃー」「ﾊﾟｰﾃｨｰ」は同じ）
 */
export function normalizeKeyword(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[\u30a1-\u30f6]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

/**
 * ゲームを確定できない理由（入るポイントが決まらない）。確定できるなら undefined。
 * 枠の無い結果入力、正解の数か点数の範囲が無い数値予想、点数の範囲が無い投票・合言葉・抽選は確定できない
 */
export function gameConfirmProblem(game: {
  format: string;
  slots: unknown[];
  ranks: unknown[];
  correctNumber?: number;
}): string | undefined {
  if (game.format === "result" && game.slots.length === 0) return "枠を追加してから確定してください";
  if (game.format === "number" && game.correctNumber === undefined) return "正解の数を入れてから確定してください";
  if (hasGameRanks(game) && game.ranks.length === 0) {
    return "点数の範囲を追加してから確定してください";
  }
  return undefined;
}

/**
 * 抽選の順番を決める（Fisher–Yates）。randomInt(n) は 0 以上 n 未満の整数を返す。
 * 渡した配列は変えない
 */
export function shuffle<T>(items: readonly T[], randomInt: (max: number) => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
