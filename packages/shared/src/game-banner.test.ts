import { describe, expect, it } from "vitest";
import { gameBannerText } from "./game-banner.js";
import type { CurrentGameDto } from "./types.js";

const game = (format: CurrentGameDto["format"], mine: Partial<CurrentGameDto> = {}): CurrentGameDto => ({
  gameId: "G1",
  format,
  name: "第 1 問",
  description: "",
  choices: [],
  ...mine,
});

describe("開催中のゲームのお知らせ", () => {
  it("形式ごとの見出しと、答える前の案内", () => {
    expect(gameBannerText(game("quiz"))).toEqual({ title: "問題が出ています", note: "第 1 問・タップして回答する" });
    expect(gameBannerText(game("number")).note).toBe("第 1 問・タップして数を予想する");
    expect(gameBannerText(game("vote"))).toEqual({ title: "投票受付中", note: "第 1 問・タップして投票する" });
    expect(gameBannerText(game("keyword", { myKeywordCorrect: false }))).toEqual({
      title: "合言葉を受付中",
      note: "第 1 問・タップして合言葉を入れる",
    });
    expect(gameBannerText(game("lottery", { myEntry: false }))).toEqual({
      title: "抽選の参加受付中",
      note: "第 1 問・タップして参加する",
    });
    expect(gameBannerText(game("result"))).toEqual({ title: "ゲーム開催中", note: "第 1 問・タップして見る" });
  });

  it("答えた後の案内（数値予想は 0 でも答えたことにする）", () => {
    expect(gameBannerText(game("quiz", { myChoiceId: "A" })).note).toContain("回答済み");
    expect(gameBannerText(game("number", { myValue: 0 })).note).toContain("回答済み");
    expect(gameBannerText(game("vote", { myTargetUserId: "U1" })).note).toContain("投票済み");
    expect(gameBannerText(game("keyword", { myKeywordCorrect: true })).note).toBe("第 1 問・正解しました");
    expect(gameBannerText(game("lottery", { myEntry: true })).note).toContain("参加済み");
  });
});
