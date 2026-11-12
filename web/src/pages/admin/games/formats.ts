import { GAME_FORMATS, GAME_NUMBER_MAX, GAME_NUMBER_MIN, type GameFormat } from "@partally/shared";

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

/** 形式ごとの、作る画面の案内（summary は形式を選ぶパネルの一言） */
export const FORMAT_TEXT: Record<
  GameFormat,
  {
    summary: string;
    about: string;
    name: string;
    descriptionLabel: string;
    description: string;
    imageLabel: string;
    note: string;
  }
> = {
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
    about: "参加者が「参加する」を押し、確定したときにアプリが無作為に決めた順番で点数が入ります",
    name: "例: ラッキー賞",
    descriptionLabel: "説明（任意）",
    description: "例: 参加ボタンを押した人の中から、抽選で 5 名にポイントをプレゼント",
    imageLabel: "画像（任意）",
    note: "確定したときに、参加した人の順番を無作為に決めて保存し、順番が入る範囲の点数が入ります（どの範囲にも入らない人は 0 点）。確定した後に範囲や点数を直しても、順番は変わりません。確定を取り消してもう一度確定すると、引き直します。点数は参加者には見せません。",
  },
  result: {
    summary: "幹事が結果を入れる",
    about: "じゃんけん大会などの結果で、枠（優勝など）ごとに人を選んで点数を付けます",
    name: "例: じゃんけん大会",
    descriptionLabel: "説明（任意）",
    description: "例: 負けた人は座ってください。最後まで残った人が優勝です",
    imageLabel: "画像（任意）",
    note: "枠は後から追加することもできます（枠が無いゲームは確定できません）。人は、保存した後に枠ごとの「人を選ぶ」で選びます。枠を削除すると、その枠で選んだ人も外れます。枠の点数は参加者には見せません。",
  },
};
