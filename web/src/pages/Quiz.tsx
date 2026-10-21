import type { CurrentQuizResponse } from "@partally/shared";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage } from "../api";
import { useParticipant } from "../components/ParticipantLayout";

/** 出題中のクイズに答える。締め切られるまで選び直せる */
export function Quiz() {
  const { quiz, setQuiz, reloadUser } = useParticipant();
  const [sending, setSending] = useState<string>();
  const [error, setError] = useState<string>();
  // 見ている間に締め切られたら、そのことを伝える
  const seenQuizId = useRef<string | undefined>(undefined);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    if (quiz) {
      seenQuizId.current = quiz.quizId;
      setClosed(false);
    } else if (quiz === null && seenQuizId.current) {
      setClosed(true);
      reloadUser();
    }
  }, [quiz, reloadUser]);

  async function answer(choiceId: string) {
    if (!quiz) return;
    setSending(choiceId);
    setError(undefined);
    try {
      const res = await api<CurrentQuizResponse>("PUT", `/quiz/${quiz.quizId}/answer`, { choiceId });
      setQuiz(res.quiz);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(undefined);
    }
  }

  if (quiz === undefined) return <p className="muted">読み込み中…</p>;

  if (!quiz) {
    return (
      <>
        <h1>クイズ</h1>
        <section className="card">
          <p>{closed ? "締め切られました。結果は発表をお待ちください。" : "今は出題中の問題はありません。"}</p>
          <p className="muted small">問題が出ると、画面の上にお知らせが出ます。</p>
          <Link to="/">ホームへ</Link>
        </section>
      </>
    );
  }

  return (
    <>
      <h1>クイズ</h1>
      <section className="card">
        <p className="quiz-text">{quiz.text}</p>
      </section>
      <div className="quiz-choices">
        {quiz.choices.map((ch) => {
          const selected = quiz.myChoiceId === ch.choiceId;
          return (
            <button
              key={ch.choiceId}
              type="button"
              className={selected ? "quiz-choice selected" : "quiz-choice"}
              aria-pressed={selected}
              disabled={sending !== undefined}
              onClick={() => answer(ch.choiceId)}
            >
              <span className="quiz-check" aria-hidden="true">
                {selected ? "✓" : ""}
              </span>
              <span>{ch.text}</span>
            </button>
          );
        })}
      </div>
      {error && <p className="error">{error}</p>}
      <p className="muted small">
        {quiz.myChoiceId ? "回答しました。締め切りまでは選び直せます。" : "選択肢を 1 つ選んでください。"}
      </p>
    </>
  );
}
