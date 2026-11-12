import {
  type CurrentGameDto,
  type GameAnswerResponse,
  type GameDto,
  gameBannerText,
  normalizeKeyword,
  type UserDto,
} from "@partally/shared";
import { useCallback, useMemo, useState } from "react";
import { type GameAnswerBody, GameView } from "../../../components/GameView";
import { Modal } from "../../../components/Modal";

/** 参加者の画面で見せる形（参加者に返す内容と同じく、点数・正解・合言葉は含めない） */
function toPreviewGame(game: GameDto): CurrentGameDto {
  return {
    gameId: game.gameId,
    format: game.format,
    name: game.name,
    description: game.description,
    imageUrl: game.imageUrl,
    choices: game.choices.map(({ choiceId, text, imageUrl }) => ({ choiceId, text, imageUrl })),
    myKeywordCorrect: game.format === "keyword" ? false : undefined,
    myEntry: game.format === "lottery" ? false : undefined,
  };
}

/**
 * 参加者の画面のプレビュー。スマホの大きさの枠に、お知らせとゲームの画面を出す（参加者の画面と同じ部品）。
 * 答えはこの画面の中だけで試せて、保存しない。投票の候補は登録済みの参加者から出す
 */
export function GamePreviewDialog(props: { game: GameDto; members: UserDto[]; onClose: () => void }) {
  const { game } = props;
  const [current, setCurrent] = useState(() => toPreviewGame(game));
  /** 「答える前に戻す」で入力中の内容も消すよう、画面を作り直す印 */
  const [resetKey, setResetKey] = useState(0);
  const banner = gameBannerText(current);
  const candidates = useMemo(
    () =>
      props.members
        .filter((u) => u.status === "active")
        .map((u) => ({ userId: u.userId, displayName: u.displayName }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName, "ja")),
    [props.members],
  );
  const loadCandidates = useCallback(async () => candidates, [candidates]);
  const noop = useCallback(() => {}, []);

  // 送らずに、参加者の画面が答えた後どう変わるかだけ見せる
  async function onAnswer(body: GameAnswerBody): Promise<GameAnswerResponse> {
    const correct = "text" in body ? normalizeKeyword(body.text) === normalizeKeyword(game.keyword ?? "") : undefined;
    const next: CurrentGameDto =
      "choiceId" in body
        ? { ...current, myChoiceId: body.choiceId }
        : "value" in body
          ? { ...current, myValue: body.value }
          : "targetUserId" in body
            ? { ...current, myTargetUserId: body.targetUserId }
            : "entry" in body
              ? { ...current, myEntry: true }
              : { ...current, myKeywordCorrect: current.myKeywordCorrect || correct };
    setCurrent(next);
    return { game: next, correct };
  }

  return (
    <Modal className="dialog game-preview-dialog" label="プレビュー" onClose={props.onClose}>
      <div className="card">
        <h2>プレビュー</h2>
        <p className="muted small">
          開催したときの参加者のスマホの画面です。答えはここで試せますが、保存はしません。
          {game.status === "draft" && "下書きのうちは、参加者には見えません。"}
        </p>
        <div className="game-preview-phone">
          <div className="participant game-preview-screen">
            <main className="page">
              <div className="quiz-banner" aria-hidden="true">
                <strong>{banner.title}</strong>
                <span className="quiz-banner-sub">{banner.note}</span>
              </div>
              <GameView
                key={resetKey}
                game={current}
                onAnswer={onAnswer}
                loadCandidates={loadCandidates}
                onClosed={noop}
              />
            </main>
          </div>
        </div>
        <div className="buttons">
          <button
            type="button"
            onClick={() => {
              setCurrent(toPreviewGame(game));
              setResetKey((k) => k + 1);
            }}
          >
            答える前に戻す
          </button>
          <button type="button" onClick={props.onClose}>
            閉じる
          </button>
        </div>
      </div>
    </Modal>
  );
}
