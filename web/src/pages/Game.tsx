import type { CurrentGameDto, GameAnswerResponse, GameCandidatesResponse } from "@partally/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api, errorMessage } from "../api";
import { type GameAnswerBody, GameView } from "../components/GameView";
import { useParticipant } from "../components/ParticipantLayout";
import { useT } from "../i18n";

/**
 * 開催中のゲーム（中身は GameView）。ラウンドなら名前の下に全問を順に並べ、1 問ずつ答える。
 * 答えは API に送り、終わったらそのことを伝える
 */
export function Game() {
  const { games, round, reloadUser } = useParticipant();
  const t = useT();
  // 見ている間に終わったら、そのことを伝える
  const seen = useRef(false);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    if (games && games.length > 0) {
      seen.current = true;
      setEnded(false);
    } else if (games && seen.current) {
      setEnded(true);
      reloadUser();
    }
  }, [games, reloadUser]);

  if (games === undefined) return <p className="muted">{t("読み込み中…", "Loading…")}</p>;

  if (games.length === 0) {
    return (
      <>
        <h1>{t("ゲーム", "Game")}</h1>
        <section className="card">
          <p>
            {ended
              ? t("終わりました。結果の発表をお待ちください。", "It’s over. Please wait for the results.")
              : t("今は開催中のゲームはありません。", "No game is running right now.")}
          </p>
          <Link to="/">{t("ホームへ", "Back to home")}</Link>
        </section>
      </>
    );
  }

  if (!round) return <GameItem game={games[0]!} />;
  return (
    <>
      <h1>{round.name}</h1>
      <ol className="round-games">
        {games.map((game, i) => (
          <li key={game.gameId} className="round-game">
            <GameItem game={game} number={i + 1} />
          </li>
        ))}
      </ol>
    </>
  );
}

/** 1 問分。送っている間・誤りは問題ごとに持つ */
function GameItem(props: { game: CurrentGameDto; number?: number }) {
  const { game } = props;
  const { setGame, closeGames, refreshGames } = useParticipant();
  const [sending, setSending] = useState<string>();
  const [error, setError] = useState<string>();
  const gameId = game.gameId;
  // 投票の候補を読み直さないよう、同じ関数を渡し続ける
  const loadCandidates = useCallback(
    async () => (await api<GameCandidatesResponse>("GET", `/game/${gameId}/candidates`)).candidates,
    [gameId],
  );

  async function answer(body: GameAnswerBody, key: string): Promise<GameAnswerResponse | undefined> {
    setSending(key);
    setError(undefined);
    try {
      const res = await api<GameAnswerResponse>("PUT", `/game/${gameId}/answer`, body);
      setGame(res.game);
      return res;
    } catch (e) {
      // 次の確認を待たずに「終わりました」に切り替える
      if (e instanceof ApiError && e.code === "game_closed") closeGames();
      // 別の端末などで先に答えていた: 今の答えを読み直して見せる
      else if (e instanceof ApiError && e.code === "already_answered") await refreshGames();
      else setError(errorMessage(e));
    } finally {
      setSending(undefined);
    }
  }

  return (
    <GameView
      game={game}
      number={props.number}
      sending={sending}
      error={error}
      onAnswer={answer}
      loadCandidates={loadCandidates}
      onClosed={closeGames}
    />
  );
}
