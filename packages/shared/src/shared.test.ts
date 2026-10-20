import { describe, expect, it } from "vitest";
import {
  EPITHET_PREFIXES,
  EPITHET_TITLES,
  formatDisplayName,
  nameSchema,
  randomEpithet,
  updateUserRequestSchema,
} from "./index.js";

describe("nameSchema", () => {
  it("全角英数・前後空白・連続空白を正規化する", () => {
    expect(nameSchema.parse("  ＴＡＮＡＫＡ　　太郎 ")).toBe("TANAKA 太郎");
  });

  it("空文字と 21 文字以上を拒否する", () => {
    expect(nameSchema.safeParse("　 ").success).toBe(false);
    expect(nameSchema.safeParse("あ".repeat(21)).success).toBe(false);
    expect(nameSchema.safeParse("あ".repeat(20)).success).toBe(true);
  });
});

describe("randomEpithet", () => {
  it("形容と称号を組み合わせる", () => {
    expect(randomEpithet(() => 0)).toBe(`${EPITHET_PREFIXES[0]}${EPITHET_TITLES[0]}`);
  });

  it("80 名分を賄える組み合わせ数がある", () => {
    const all = new Set(EPITHET_PREFIXES.flatMap((p) => EPITHET_TITLES.map((t) => p + t)));
    expect(all.size).toBeGreaterThanOrEqual(2000);
  });

  it("すべての組み合わせが二つ名の上限文字数に収まる", () => {
    const longest = Math.max(...EPITHET_PREFIXES.map((p) => p.length)) +
      Math.max(...EPITHET_TITLES.map((t) => t.length));
    expect(longest).toBeLessThanOrEqual(20);
  });
});

describe("formatDisplayName", () => {
  it("〈二つ名〉名前 の形式にする", () => {
    expect(formatDisplayName("疾風の魔術師", "田中")).toBe("〈疾風の魔術師〉田中");
  });
});

describe("updateUserRequestSchema", () => {
  it("name と epithet のどちらも無い場合は拒否する", () => {
    expect(updateUserRequestSchema.safeParse({}).success).toBe(false);
    expect(updateUserRequestSchema.safeParse({ epithet: "王" }).success).toBe(true);
  });
});
