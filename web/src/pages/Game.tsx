import type { CurrentGameResponse } from "@partally/shared";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api, errorMessage } from "../api";
import { useParticipant } from "../components/ParticipantLayout";

/**
 * 開催中のゲーム。クイズ形式は選択肢から選んで答え（確定されるまで選び直せる）、
 * 結果入力形式は説明と、枠ごとの点数を見せる
 */
export function Game() {
  const { game, setGame, reloadUser } = useParticipant();
  const [sending, setSending] = useState<string>();
  const [error, setError] = useState<string>();
  // 見ている間に終わったら、そのことを伝える
  const seenGameId = useRef<string | undefined>(undefined);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    if (game) {
      seenGameId.current = game.gameId;
      setEnded(false);
    } else if (game === null && seenGameId.current) {
      setEnded(true);
      reloadUser();
    }
  }, [game, reloadUser]);

  async function answer(choiceId: string) {
    if (!game) return;
    setSending(choiceId);
    setError(undefined);
    try {
      const res = await api<CurrentGameResponse>("PUT", `/game/${game.gameId}/answer`, { choiceId });
      setGame(res.game);
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
    <>
      <h1>{game.name}</h1>
      {(game.imageUrl || game.description) && (
        <section className="card">
          {game.imageUrl && <img className="game-image" src={game.imageUrl} alt="問題の画像" />}
          {game.description && <p className="quiz-text">{game.description}</p>}
        </section>
      )}
      {game.format === "quiz" ? (
        <>
          <div className={game.choices.some((ch) => ch.imageUrl) ? "quiz-choices with-images" : "quiz-choices"}>
            {game.choices.map((ch) => {
              const selected = game.myChoiceId === ch.choiceId;
              return (
                <button
                  key={ch.choiceId}
                  type="button"
                  className={selected ? "quiz-choice selected" : "quiz-choice"}
                  aria-pressed={selected}
                  disabled={sending !== undefined}
                  onClick={() => answer(ch.choiceId)}
                >
                  {ch.imageUrl && <img className="quiz-choice-image" src={ch.imageUrl} alt="" />}
                  <span className="quiz-choice-text">
                    <span className="quiz-check" aria-hidden="true">
                      {selected ? "✓" : ""}
                    </span>
                    <span>{ch.text}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {error && <p className="error">{error}</p>}
          <p className="muted small">
            {game.myChoiceId ? "回答しました。締め切りまでは選び直せます。" : "選択肢を 1 つ選んでください。"}
          </p>
        </>
      ) : (
        <section className="card">
          {game.slots.length > 0 ? (
            <ul className="game-points">
              {game.slots.map((s, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 枠の並びは幹事が決めた順で、名前が同じこともある
                <li key={i}>
                  <span>{s.name}</span>
                  <span className="game-award-points">{s.points} 点</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">点数はこれから決まります。</p>
          )}
          <p className="muted small">結果が決まると、入った枠の点数がポイントに入ります。</p>
        </section>
      )}
    </>
  );
}
