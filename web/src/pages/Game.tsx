import type { GameAnswerResponse, GameCandidatesResponse } from "@partally/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api, errorMessage } from "../api";
import { type GameAnswerBody, GameView } from "../components/GameView";
import { useParticipant } from "../components/ParticipantLayout";

/** 開催中のゲーム（中身は GameView）。答えは API に送り、終わったらそのことを伝える */
export function Game() {
  const { game, setGame, reloadUser } = useParticipant();
  const [sending, setSending] = useState<string>();
  const [error, setError] = useState<string>();
  // 見ている間に終わったら、そのことを伝える
  const seenGameId = useRef<string | undefined>(undefined);
  const [ended, setEnded] = useState(false);
  // 投票の候補を読み直さないよう、同じ関数を渡し続ける
  const closeGame = useCallback(() => setGame(null), [setGame]);
  const gameId = game?.gameId;
  const loadCandidates = useCallback(
    async () => (await api<GameCandidatesResponse>("GET", `/game/${gameId}/candidates`)).candidates,
    [gameId],
  );

  useEffect(() => {
    if (game) {
      seenGameId.current = game.gameId;
      setEnded(false);
    } else if (game === null && seenGameId.current) {
      setEnded(true);
      reloadUser();
    }
  }, [game, reloadUser]);

  async function answer(body: GameAnswerBody, key: string): Promise<GameAnswerResponse | undefined> {
    if (!game) return;
    setSending(key);
    setError(undefined);
    try {
      const res = await api<GameAnswerResponse>("PUT", `/game/${game.gameId}/answer`, body);
      setGame(res.game);
      return res;
    } catch (e) {
      // 次の確認を待たずに「終わりました」に切り替える
      if (e instanceof ApiError && e.code === "game_closed") setGame(null);
      else setError(errorMessage(e));
    } finally {
      setSending(undefined);
    }
  }

  if (game === undefined) return <p className="muted">読み込み中…</p>;

  if (!game) {
    return (
      <>
        <h1>ゲーム</h1>
        <section className="card">
          <p>{ended ? "終わりました。結果の発表をお待ちください。" : "今は開催中のゲームはありません。"}</p>
          <p className="muted small">ゲームが始まると、画面の上にお知らせが出ます。</p>
          <Link to="/">ホームへ</Link>
        </section>
      </>
    );
  }

  return (
    <GameView
      game={game}
      sending={sending}
      error={error}
      onAnswer={answer}
      loadCandidates={loadCandidates}
      onClosed={closeGame}
    />
  );
}
