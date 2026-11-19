import type { CurrentGameDto } from "./types.js";

/**
 * 開催中のゲームのお知らせの見出しと案内（答えたかどうかで変える）。
 * 参加者の画面の上のお知らせと、管理画面のプレビューで共通
 */
export function gameBannerText(game: CurrentGameDto, lang: "ja" | "en" = "ja"): { title: string; note: string } {
  if (lang === "en") return { title: BANNER_TITLE_EN[game.format], note: `${game.name} · ${bannerNoteEn(game)}` };
  return { title: BANNER_TITLE[game.format], note: `${game.name}・${bannerNote(game)}` };
}

/** お知らせの見出し（参加者がすることが分かるように、形式で変える） */
const BANNER_TITLE: Record<CurrentGameDto["format"], string> = {
  quiz: "問題が出ています",
  number: "問題が出ています",
  vote: "投票受付中",
  keyword: "合言葉を受付中",
  lottery: "抽選の参加受付中",
  result: "ゲーム開催中",
};

function bannerNote(game: CurrentGameDto): string {
  switch (game.format) {
    case "quiz":
      return game.myChoiceId ? "回答済み" : "タップして回答する";
    case "number":
      return game.myValue !== undefined ? "回答済み" : "タップして数を予想する";
    case "keyword":
      return game.myKeywordCorrect ? "正解しました" : "タップして合言葉を入れる";
    case "lottery":
      return game.myEntry ? "参加済み" : "タップして参加する";
    case "vote":
      return game.myTargetUserId ? "投票済み" : "タップして投票する";
    default:
      return "タップして見る";
  }
}

const BANNER_TITLE_EN: Record<CurrentGameDto["format"], string> = {
  quiz: "A question is live",
  number: "A question is live",
  vote: "Voting is open",
  keyword: "Keyword entry is open",
  lottery: "Lottery entry is open",
  result: "A game is on",
};

function bannerNoteEn(game: CurrentGameDto): string {
  switch (game.format) {
    case "quiz":
      return game.myChoiceId ? "Answered" : "Tap to answer";
    case "number":
      return game.myValue !== undefined ? "Answered" : "Tap to guess the number";
    case "keyword":
      return game.myKeywordCorrect ? "Correct!" : "Tap to enter the keyword";
    case "lottery":
      return game.myEntry ? "Entered" : "Tap to enter";
    case "vote":
      return game.myTargetUserId ? "Voted" : "Tap to vote";
    default:
      return "Tap to view";
  }
}

/** 答えた（参加した・合言葉に正解した）か。結果入力は答えるものが無いので undefined */
export function isGameAnswered(game: CurrentGameDto): boolean | undefined {
  switch (game.format) {
    case "quiz":
      return game.myChoiceId !== undefined;
    case "number":
      return game.myValue !== undefined;
    case "vote":
      return game.myTargetUserId !== undefined;
    case "keyword":
      return game.myKeywordCorrect === true;
    case "lottery":
      return game.myEntry === true;
    default:
      return undefined;
  }
}

/** 開催中のラウンドのお知らせ（例: 第 1 部・3 問中 1 問回答済み） */
export function roundBannerText(
  round: { name: string },
  games: CurrentGameDto[],
  lang: "ja" | "en" = "ja",
): { title: string; note: string } {
  const answerable = games.map(isGameAnswered).filter((a) => a !== undefined);
  const done = answerable.filter(Boolean).length;
  if (lang === "en") {
    const note = answerable.length === 0 ? "Tap to view" : `${done} of ${answerable.length} answered`;
    return { title: "Questions are live", note: `${round.name} · ${note}` };
  }
  const note = answerable.length === 0 ? "タップして見る" : `${answerable.length} 問中 ${done} 問回答済み`;
  return { title: "問題が出ています", note: `${round.name}・${note}` };
}
