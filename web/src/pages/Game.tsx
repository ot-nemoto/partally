import { type CurrentGameResponse, formatRankRange, GAME_NUMBER_MAX, GAME_NUMBER_MIN } from "@partally/shared";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api, errorMessage } from "../api";
import { NumberField } from "../components/NumberField";
import { useParticipant } from "../components/ParticipantLayout";

/**
 * 開催中のゲーム。クイズ形式は選択肢から選んで答え（確定されるまで選び直せる）、
 * 数値予想は数を入れて答え（確定されるまで答え直せる）、結果入力形式は説明と、枠ごとの点数を見せる
 */
export function Game() {
  const { game, setGame, reloadUser } = useParticipant();
  const [sending, setSending] = useState<string>();
  const [error, setError] = useState<string>();
  // 見ている間に終わったら、そのことを伝える
  const seenGameId = useRef<string | undefined>(undefined);
  const [ended, setEnded] = useState(false);
  /** 数値予想で入れている数（空欄は NaN） */
  const [value, setValue] = useState(Number.NaN);

  useEffect(() => {
    if (game) {
      seenGameId.current = game.gameId;
      setEnded(false);
    } else if (game === null && seenGameId.current) {
      setEnded(true);
      reloadUser();
    }
  }, [game, reloadUser]);

  // 別のゲームに変わったら、入れている数をそのゲームの自分の答えにする
  const gameId = game?.gameId;
  const myValue = game?.myValue;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 答え直すたびには入れ直さない（入力中の数を消さないように）
  useEffect(() => {
    setValue(myValue ?? Number.NaN);
  }, [gameId]);

  async function answer(body: { choiceId: string } | { value: number }, key: string) {
    if (!game) return;
    setSending(key);
    setError(undefined);
    try {
      const res = await api<CurrentGameResponse>("PUT", `/game/${game.gameId}/answer`, body);
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
                  onClick={() => answer({ choiceId: ch.choiceId }, ch.choiceId)}
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
      ) : game.format === "number" ? (
        <>
          <form
            className="card game-number-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!Number.isNaN(value)) void answer({ value }, "value");
            }}
          >
            <NumberField
              label="予想する数"
              value={value}
              min={GAME_NUMBER_MIN}
              max={GAME_NUMBER_MAX}
              onChange={setValue}
            />
            <button
              type="submit"
              className="primary"
              disabled={sending !== undefined || Number.isNaN(value) || value === game.myValue}
            >
              {game.myValue === undefined ? "答える" : "答え直す"}
            </button>
            {error && <p className="error">{error}</p>}
            <p className="small" aria-live="polite">
              {game.myValue === undefined ? (
                <span className="muted">数を入れて「答える」を押してください。</span>
              ) : (
                <>
                  あなたの答え: <strong className="game-number-mine">{game.myValue}</strong>
                  <span className="muted">（締め切りまでは答え直せます）</span>
                </>
              )}
            </p>
          </form>
          <section className="card">
            {game.ranks.length > 0 ? (
              <ul className="game-points">
                {game.ranks.map((r) => (
                  <li key={r.from}>
                    <span>{formatRankRange(r)}</span>
                    <span className="game-award-points">{r.points} 点</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">点数はこれから決まります。</p>
            )}
            <p className="muted small">
              正解に近い順に順位が付き（同じだけ離れた人は同じ順位）、順位に応じた点数が入ります。
            </p>
          </section>
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
