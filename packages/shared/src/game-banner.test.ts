import { describe, expect, it } from "vitest";
import { gameBannerText, roundBannerText } from "./game-banner.js";
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

  it("英語の画面では英語の見出しと案内（ゲームの名前はそのまま）", () => {
    expect(gameBannerText(game("quiz"), "en")).toEqual({
      title: "A question is live",
      note: "第 1 問 · Tap to answer",
    });
    expect(gameBannerText(game("vote", { myTargetUserId: "U1" }), "en").note).toBe("第 1 問 · Voted");
    expect(gameBannerText(game("number", { myValue: 0 }), "en").note).toContain("Answered");
  });
});

describe("開催中のラウンドのお知らせ", () => {
  it("答えた問題の数を出す（結果入力は数えない）", () => {
    const games = [game("quiz", { myChoiceId: "A" }), game("number"), game("result")];
    expect(roundBannerText({ name: "第 1 部" }, games)).toEqual({
      title: "問題が出ています",
      note: "第 1 部・2 問中 1 問回答済み",
    });
    expect(roundBannerText({ name: "Part 1" }, games, "en").note).toBe("Part 1 · 1 of 2 answered");
    expect(roundBannerText({ name: "大会" }, [game("result")]).note).toBe("大会・タップして見る");
  });
});
