import { PRIZE_POSITION_MAX } from "./schemas.js";
import type { PrizeDto, RankingEntryDto } from "./types.js";

/**
 * 「1, 3, 5-10」のような順位の指定を読む。区切りは「,」「、」・空白、範囲は「-」「〜」「~」。
 * 全角数字も読める。小さい順・重複なしにして返す
 */
export function parsePositions(text: string): { positions: number[] } | { error: string } {
  const normalized = text.normalize("NFKC").replace(/[〜~ー‐‑‒–—―−]/g, "-");
  const positions = new Set<number>();
  for (const part of normalized.split(/[,、\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return { error: `「${part}」を順位として読めません` };
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from < 1 || to < from) return { error: `「${part}」は順位の範囲になっていません` };
    if (to > PRIZE_POSITION_MAX) return { error: `順位は ${PRIZE_POSITION_MAX} 位までです` };
    for (let p = from; p <= to; p++) positions.add(p);
  }
  return { positions: [...positions].sort((a, b) => a - b) };
}

/** 順位の一覧を、続いている所は範囲にまとめて書く（[1, 2, 3, 5] → 「1-3, 5」） */
export function formatPositions(positions: number[]): string {
  const sorted = [...positions].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const from = sorted[i]!;
    let to = from;
    while (sorted[i + 1] === to + 1) to = sorted[++i]!;
    parts.push(to === from ? String(from) : `${from}-${to}`);
  }
  return parts.join(", ");
}

/** 参加者に見せる順位の書き方。続いている所は範囲にする（[1, 2, 3, 5] → 「1〜3 位・5 位」） */
export function formatPositionLabel(positions: number[]): string {
  return formatPositions(positions)
    .split(", ")
    .filter(Boolean)
    .map((part) => `${part.replace("-", "〜")} 位`)
    .join("・");
}

/**
 * 参加者に見せる景品。どの順位にも割り当てていない景品は除き、上位の景品から並べる
 * （渡す順位の最も小さい順。同じなら渡す人数の少ない順＝その順位向けの景品を先に。それも同じなら元の並び＝登録した順）
 */
export function prizesForDisplay(prizes: PrizeDto[]): PrizeDto[] {
  return prizes
    .filter((p) => p.positions.length > 0)
    .map((p) => ({ prize: p, top: Math.min(...p.positions) }))
    .sort((a, b) => a.top - b.top || a.prize.positions.length - b.prize.positions.length)
    .map(({ prize }) => prize);
}

/** 順位（上から何番目の人か）ごとの景品。景品は登録した順 */
export function prizesByPosition(prizes: PrizeDto[]): Map<number, PrizeDto[]> {
  const map = new Map<number, PrizeDto[]>();
  for (const prize of prizes) {
    for (const position of prize.positions) map.set(position, [...(map.get(position) ?? []), prize]);
  }
  return new Map([...map].sort(([a], [b]) => a - b));
}

/**
 * ランキングの各行が何番目の人か。景品は上から 1 人ずつ渡すので、同点でも並び順で数える。
 * 紐づけを解除した人は景品を受け取らないので数えない（undefined）
 */
export function prizePositions(ranking: RankingEntryDto[]): Map<string, number> {
  const positions = new Map<string, number>();
  for (const entry of ranking) if (entry.status !== "unbound") positions.set(entry.userId, positions.size + 1);
  return positions;
}
