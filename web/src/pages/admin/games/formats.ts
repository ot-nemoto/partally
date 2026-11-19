import { GAME_FORMATS, GAME_NUMBER_MAX, GAME_NUMBER_MIN, type GameFormat } from "@partally/shared";
import type { Lang } from "../../../i18n";

/** 形式を選ぶパネルの並び（参加者が答える形式を先に、結果入力を最後に） */
export const FORMAT_ORDER: GameFormat[] = [...GAME_FORMATS].sort(
  (a, b) => Number(a === "result") - Number(b === "result"),
);

/** 形式のアイコン（形式を選ぶパネルとカードに出す） */
export const FORMAT_ICON: Record<GameFormat, string> = {
  quiz: "❓",
  number: "🔢",
  vote: "🗳️",
  keyword: "🔑",
  lottery: "🎲",
  result: "🏆",
};

interface FormatText {
  summary: string;
  about: string;
  name: string;
  descriptionLabel: string;
  description: string;
  imageLabel: string;
  note: string;
}

/** 形式ごとの、作る画面の案内（summary は形式を選ぶパネルの一言）。英語は FORMAT_TEXT_EN */
export function formatText(format: GameFormat, lang: Lang): FormatText {
  return (lang === "en" ? FORMAT_TEXT_EN : FORMAT_TEXT)[format];
}

const FORMAT_TEXT: Record<GameFormat, FormatText> = {
  quiz: {
    summary: "選択肢から選ぶ",
    about: "参加者がスマホで選択肢から選び、選んだ答えの点数が入ります",
    name: "例: 第 1 問",
    descriptionLabel: "問題文",
    description: "例: 幹事の出身地は？",
    imageLabel: "問題の画像（任意）",
    note: "正解は 10 点、惜しい答えは 5 点のように、選択肢ごとに点数を決められます。参加者には点数は見せません。",
  },
  number: {
    summary: "数を予想する",
    about: `参加者が数（${GAME_NUMBER_MIN}〜${GAME_NUMBER_MAX}）を予想し、正解に近い順の順位で点数が入ります`,
    name: "例: 瓶の中の飴の数",
    descriptionLabel: "問題文",
    description: "例: 瓶の中に飴は何個入っている？",
    imageLabel: "問題の画像（任意）",
    note: "正解に近い順に順位を付け、順位が入る範囲の点数が入ります（同じだけ離れた人は同じ順位。どの範囲にも入らない順位は 0 点）。点数と正解の数は参加者には見せません。",
  },
  vote: {
    summary: "1 人に投票する",
    about: "参加者が全員の中から 1 人に投票し、票の多い順の順位で選ばれた人に点数が入ります",
    name: "例: 今日の MVP",
    descriptionLabel: "説明（任意）",
    description: "例: 今日いちばん盛り上げた人に投票してください",
    imageLabel: "画像（任意）",
    note: "票の多い順に順位を付け、選ばれた人に順位が入る範囲の点数が入ります（同じ票数は同じ順位。0 票の人とどの範囲にも入らない順位は 0 点）。自分と、紐づけを解除した人には投票できません。点数と、誰が誰に投票したかは参加者には見せません。",
  },
  keyword: {
    summary: "見つけた言葉を入れる",
    about: "会場で見つけた合言葉を参加者が入れ、正解した順（先着順）で点数が入ります",
    name: "例: 宝探し",
    descriptionLabel: "説明（任意）",
    description: "例: 会場のどこかに合言葉が隠れています。見つけたら入れてください",
    imageLabel: "画像（任意）",
    note: "正解した順に番号を付け、番号が入る範囲の点数が入ります（どの範囲にも入らない番号は 0 点）。全角・半角、大文字・小文字、カタカナ・ひらがな、空白の違いは同じ言葉として扱います。点数と合言葉は参加者には見せません。",
  },
  lottery: {
    summary: "参加して抽選",
    about: "参加者が「参加する」を押し、終了したときにアプリが無作為に決めた順番で点数が入ります",
    name: "例: ラッキー賞",
    descriptionLabel: "説明（任意）",
    description: "例: 参加ボタンを押した人の中から、抽選で 5 名にポイントをプレゼント",
    imageLabel: "画像（任意）",
    note: "終了したときに、参加した人の順番を無作為に決めて保存し、順番が入る範囲の点数が入ります（どの範囲にも入らない人は 0 点）。終了した後に範囲や点数を直しても、順番は変わりません。終了を取り消して開始し直してもう一度終了すると、引き直します。点数は参加者には見せません。",
  },
  result: {
    summary: "幹事が結果を入れる",
    about: "じゃんけん大会などの結果で、枠（優勝など）ごとに人を選んで点数を付けます",
    name: "例: じゃんけん大会",
    descriptionLabel: "説明（任意）",
    description: "例: 負けた人は座ってください。最後まで残った人が優勝です",
    imageLabel: "画像（任意）",
    note: "枠は後から追加することもできます（枠が無いゲームは終了できません）。人は、保存した後に枠ごとの「人を選ぶ」で選びます。枠を削除すると、その枠で選んだ人も外れます。枠の点数は参加者には見せません。",
  },
};

const FORMAT_TEXT_EN: Record<GameFormat, FormatText> = {
  quiz: {
    summary: "Pick an answer",
    about: "Participants pick an answer on their phones, and get the points of the answer they picked",
    name: "e.g. Question 1",
    descriptionLabel: "Question",
    description: "e.g. Where is the organizer from?",
    imageLabel: "Question image (optional)",
    note: "You can set points for each answer, such as 10 for the right one and 5 for a close one. Participants don’t see the points.",
  },
  number: {
    summary: "Guess a number",
    about: `Participants guess a number (${GAME_NUMBER_MIN}–${GAME_NUMBER_MAX}), and get points by how close they are to the answer`,
    name: "e.g. Candies in the jar",
    descriptionLabel: "Question",
    description: "e.g. How many candies are in the jar?",
    imageLabel: "Question image (optional)",
    note: "Guesses are ranked by how close they are, and each rank range gets its points (equal distances share a rank; ranks outside every range get 0). Participants don’t see the points or the correct number.",
  },
  vote: {
    summary: "Vote for one person",
    about: "Participants vote for one person, and the people voted for get points by vote ranking",
    name: "e.g. Today’s MVP",
    descriptionLabel: "Description (optional)",
    description: "e.g. Vote for the person who livened up the party the most",
    imageLabel: "Image (optional)",
    note: "People are ranked by votes, and each rank range gets its points (equal votes share a rank; people with 0 votes and ranks outside every range get 0). Participants can’t vote for themselves or unlinked people. Participants don’t see the points or who voted for whom.",
  },
  keyword: {
    summary: "Enter a found word",
    about: "Participants enter a keyword hidden at the venue, and get points in the order they answer correctly",
    name: "e.g. Treasure hunt",
    descriptionLabel: "Description (optional)",
    description: "e.g. A keyword is hidden somewhere in the venue. Enter it when you find it",
    imageLabel: "Image (optional)",
    note: "Correct answers are numbered in order, and each range gets its points (numbers outside every range get 0). Full-/half-width, upper/lower case, katakana/hiragana and spaces are treated as the same. Participants don’t see the points or the keyword.",
  },
  lottery: {
    summary: "Enter and draw",
    about: "Participants tap “Enter”, and when you end it, the app draws a random order that decides the points",
    name: "e.g. Lucky prize",
    descriptionLabel: "Description (optional)",
    description: "e.g. 5 people who enter will win points in a draw",
    imageLabel: "Image (optional)",
    note: "When you end it, the entrants are put in a random order that is saved, and each range of the order gets its points (people outside every range get 0). Changing the ranges or points after ending doesn’t change the order. Undoing, starting it again and ending redraws. Participants don’t see the points.",
  },
  result: {
    summary: "You enter the results",
    about:
      "For results like a rock-paper-scissors contest, choose people for each slot (winner, etc.) to give them points",
    name: "e.g. Rock-paper-scissors contest",
    descriptionLabel: "Description (optional)",
    description: "e.g. Sit down when you lose. The last one standing wins",
    imageLabel: "Image (optional)",
    note: "You can add slots later (a game with no slots can’t be ended). Choose people for each slot with “Choose people” after saving. Deleting a slot also removes the people chosen for it. Participants don’t see the slot points.",
  },
};
