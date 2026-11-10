import type { CurrentGameDto } from "./types.js";

/**
 * 開催中のゲームのお知らせの見出しと案内（答えたかどうかで変える）。
 * 参加者の画面の上のお知らせと、管理画面のプレビューで共通
 */
export function gameBannerText(game: CurrentGameDto): { title: string; note: string } {
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
      return game.myChoiceId ? "回答済み（締め切りまで選び直せます）" : "タップして回答する";
    case "number":
      return game.myValue !== undefined ? "回答済み（締め切りまで答え直せます）" : "タップして数を予想する";
    case "keyword":
      return game.myKeywordCorrect ? "正解しました" : "タップして合言葉を入れる";
    case "lottery":
      return game.myEntry ? "参加済み（締め切られると抽選します）" : "タップして参加する";
    case "vote":
      return game.myTargetUserId ? "投票済み（締め切りまで選び直せます）" : "タップして投票する";
    default:
      return "タップして見る";
  }
}
