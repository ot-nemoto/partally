import { describe, expect, it } from "vitest";
import { formatRankRange, normalizeKeyword, rankNumberAnswers, shuffle, tallyVotes } from "./number-game.js";

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

describe("投票の集計", () => {
  it("票の多い順に順位を付け、同じ票数は同じ順位（次は人数分飛ばす）にして、範囲の点数を付ける", () => {
    const ranks = [
      { from: 1, to: 1, points: 30 },
      { from: 2, to: 3, points: 10 },
    ];
    // a 3 票、b・c 2 票、d 1 票
    const result = tallyVotes(["a", "b", "a", "c", "d", "b", "a", "c"], ranks);
    expect(result).toEqual([
      { userId: "a", votes: 3, rank: 1, points: 30 },
      { userId: "b", votes: 2, rank: 2, points: 10 },
      { userId: "c", votes: 2, rank: 2, points: 10 },
      { userId: "d", votes: 1, rank: 4, points: 0 },
    ]);
  });

  it("票が無ければ空", () => {
    expect(tallyVotes([], [{ from: 1, to: 1, points: 1 }])).toEqual([]);
  });
});

describe("合言葉の比べ方", () => {
  it("全角・半角、大文字・小文字、カタカナ・ひらがな、空白の違いをなくす", () => {
    const base = normalizeKeyword("ぱーてぃー 2026");
    for (const s of ["パーティー2026", "ﾊﾟｰﾃｨｰ ２０２６", " ぱーてぃー　2026 "]) expect(normalizeKeyword(s)).toBe(base);
    expect(normalizeKeyword("ABC")).toBe(normalizeKeyword("ａｂｃ"));
    expect(normalizeKeyword("ぱーてぃ")).not.toBe(base);
  });
});

describe("抽選の順番", () => {
  it("渡した乱数で並べ替え、元の配列は変えない", () => {
    const items = ["a", "b", "c", "d"];
    // 常に 0 を返すと、後ろから順に先頭と入れ替わる
    expect(shuffle(items, () => 0)).toEqual(["b", "c", "d", "a"]);
    // 常に最大を返すと、そのまま
    expect(shuffle(items, (max) => max - 1)).toEqual(items);
    expect(items).toEqual(["a", "b", "c", "d"]);
    expect(shuffle([], () => 0)).toEqual([]);
  });

  it("すべての並びが同じくらい出る", () => {
    const counts = new Map<string, number>();
    for (let n = 0; n < 6000; n++) {
      const key = shuffle(["a", "b", "c"], (max) => Math.floor(Math.random() * max)).join("");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(6);
    for (const c of counts.values()) expect(c).toBeGreaterThan(800);
  });
});
