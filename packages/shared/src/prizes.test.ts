import { describe, expect, it } from "vitest";
import {
  formatPositions,
  type PrizeDto,
  parsePositions,
  prizePositions,
  prizeRequestSchema,
  prizesByPosition,
  type RankingEntryDto,
} from "./index.js";

describe("parsePositions", () => {
  it("区切り・範囲・全角を読み、小さい順・重複なしにする", () => {
    expect(parsePositions("3, 1、５〜７ 6")).toEqual({ positions: [1, 3, 5, 6, 7] });
    expect(parsePositions("10-12")).toEqual({ positions: [10, 11, 12] });
    expect(parsePositions("5‐6, 8―9")).toEqual({ positions: [5, 6, 8, 9] });
    expect(parsePositions("  ")).toEqual({ positions: [] });
  });

  it("順位として読めない指定はエラーにする", () => {
    expect(parsePositions("1, a")).toEqual({ error: "「a」を順位として読めません" });
    expect(parsePositions("0")).toHaveProperty("error");
    expect(parsePositions("5-3")).toHaveProperty("error");
    expect(parsePositions("1-1001")).toHaveProperty("error");
  });
});

describe("formatPositions", () => {
  it("続いている所は範囲にまとめる", () => {
    expect(formatPositions([5, 1, 2, 3, 7, 8])).toBe("1-3, 5, 7-8");
    expect(formatPositions([])).toBe("");
  });
});

const prize = (prizeId: string, positions: number[]): PrizeDto => ({
  prizeId,
  name: prizeId,
  quantity: positions.length,
  positions,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("prizesByPosition", () => {
  it("順位ごとに、登録した順で景品をまとめる", () => {
    const map = prizesByPosition([prize("A", [2, 1]), prize("B", [1])]);
    expect([...map].map(([p, list]) => [p, list.map((x) => x.prizeId)])).toEqual([
      [1, ["A", "B"]],
      [2, ["A"]],
    ]);
  });
});

describe("prizePositions", () => {
  it("同点でも並び順で 1 人ずつ数え、紐づけを解除した人は数えない", () => {
    const entry = (userId: string, rank: number, status: RankingEntryDto["status"] = "active"): RankingEntryDto => ({
      rank,
      userId,
      name: userId,
      epithet: "",
      displayName: userId,
      status,
      points: 0,
      history: [],
    });
    const map = prizePositions([entry("a", 1), entry("b", 1), entry("x", 3, "unbound"), entry("c", 4)]);
    expect([...map]).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
  });
});

describe("prizeRequestSchema", () => {
  it("数量を超える割り当てと重複した順位を拒否する", () => {
    expect(prizeRequestSchema.safeParse({ name: "A", quantity: 2, positions: [1, 2] }).success).toBe(true);
    expect(prizeRequestSchema.safeParse({ name: "A", quantity: 1, positions: [1, 2] }).success).toBe(false);
    expect(prizeRequestSchema.safeParse({ name: "A", quantity: 2, positions: [1, 1] }).success).toBe(false);
  });
});
