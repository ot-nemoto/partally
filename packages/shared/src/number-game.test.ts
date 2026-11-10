import { describe, expect, it } from "vitest";
import { formatRankRange, rankNumberAnswers } from "./number-game.js";

describe("数値予想の順位", () => {
  const ranks = [
    { from: 1, to: 2, points: 30 },
    { from: 3, to: 5, points: 10 },
  ];

  it("正解に近い順に順位を付け、同じ差は同じ順位（次は人数分飛ばす）にして、範囲の点数を付ける", () => {
    // 正解 50: 差は 0, 2, 2, 5, 10, 40
    const result = rankNumberAnswers([50, 48, 52, 45, 60, 90], 50, ranks);
    expect(result.map((r) => [r.diff, r.rank, r.points])).toEqual([
      [0, 1, 30],
      [2, 2, 30],
      [2, 2, 30],
      [5, 4, 10],
      [10, 5, 10],
      [40, 6, 0],
    ]);
  });

  it("同じ差が範囲をまたぐときも同じ順位（その順位の範囲の点数）", () => {
    const result = rankNumberAnswers([10, 20, 20, 20], 15, ranks);
    // 差 5 が 4 人とも 1 位
    expect(result.map((r) => [r.rank, r.points])).toEqual([
      [1, 30],
      [1, 30],
      [1, 30],
      [1, 30],
    ]);
    expect(rankNumberAnswers([], 15, ranks)).toEqual([]);
  });

  it("範囲の書き方", () => {
    expect(formatRankRange({ from: 1, to: 5 })).toBe("1〜5 位");
    expect(formatRankRange({ from: 3, to: 3 })).toBe("3 位");
  });
});
