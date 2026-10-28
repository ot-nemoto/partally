import {
  POINTS_MAX,
  QUIZ_CHOICE_TEXT_MAX_LENGTH,
  QUIZ_CHOICES_MAX,
  QUIZ_CHOICES_MIN,
  QUIZ_TEXT_MAX_LENGTH,
  type QuizDto,
  type QuizResponse,
  type QuizResultsResponse,
  type QuizStatus,
  type QuizzesResponse,
} from "@partally/shared";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../api";
import { Modal } from "../../components/Modal";
import { NumberField } from "../../components/NumberField";
import { PageTitle } from "../../components/PageTitle";
import { useOnReload } from "../../hooks/useReload";

const STATUS_LABEL: Record<QuizStatus, string> = { draft: "下書き", open: "出題中", closed: "締め切り" };
/** 一覧の並び順。出題中 → 下書き（これから出す）→ 締め切りの順で、同じ状態の中は作成順 */
const STATUS_ORDER: Record<QuizStatus, number> = { open: 0, draft: 1, closed: 2 };

export function AdminQuizzes() {
  const [quizzes, setQuizzes] = useState<QuizDto[]>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<QuizDto | "new">();
  const [results, setResults] = useState<QuizDto>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api<QuizzesResponse>("GET", "/admin/quizzes");
      setQuizzes(res.quizzes);
      setError(undefined);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useOnReload(load);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      await load();
    } catch (e) {
      alert(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const open = (q: QuizDto) => run(() => api<QuizResponse>("POST", `/admin/quizzes/${q.quizId}/open`));
  const close = (q: QuizDto) => {
    if (!confirm("回答の受付を締め切ります。締め切った問題はもう一度出題できません。よろしいですか？")) return;
    return run(() => api<QuizResponse>("POST", `/admin/quizzes/${q.quizId}/close`));
  };
  const remove = (q: QuizDto) => {
    const note = q.answerCount > 0 ? `\n${q.answerCount} 人の回答と、その点数も消えます。` : "";
    if (!confirm(`この問題を削除します。${note}\nよろしいですか？`)) return;
    return run(() => api("DELETE", `/admin/quizzes/${q.quizId}`));
  };

  const hasOpen = quizzes?.some((q) => q.status === "open") ?? false;
  // 「第 N 問」は作成順の番号のまま、並びだけ状態順にする
  const sorted = (quizzes ?? [])
    .map((quiz, i) => ({ quiz, number: i + 1 }))
    .sort((a, b) => STATUS_ORDER[a.quiz.status] - STATUS_ORDER[b.quiz.status]);

  const header = (q: QuizDto, number: number) => (
    <>
      <span className="muted small">第 {number} 問</span>
      <span className={`status status-${q.status}`}>{STATUS_LABEL[q.status]}</span>
      {q.status !== "draft" && <span className="muted small">回答 {q.answerCount} 人</span>}
    </>
  );

  return (
    <section className="admin-quizzes">
      <PageTitle en="Quiz" ja="クイズ" />
      <p className="muted small">
        {"「出題」を押すと参加者の画面に問題が出ます。出題中にできるのは 1 問だけです。"}
        {
          "締め切った時点の回答で、選んだ選択肢の点数がポイントに入ります（正解はアプリには出さないので、司会から発表してください）。"
        }
      </p>
      <div className="buttons start">
        <button type="button" className="primary" onClick={() => setEditing("new")}>
          問題を作る
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {quizzes?.length === 0 && <p className="muted">まだ問題がありません。</p>}
      {sorted.map(({ quiz: q, number }) => {
        const body = (
          <>
            <ul className="quiz-admin-choices">
              {q.choices.map((ch) => (
                <li key={ch.choiceId}>
                  <span>{ch.text}</span>
                  <span className="muted small">{ch.points} 点</span>
                  {q.status !== "draft" && <span className="num">{ch.answerCount} 人</span>}
                </li>
              ))}
            </ul>
            <div className="actions">
              {q.status === "draft" && (
                <button type="button" className="primary" onClick={() => open(q)} disabled={busy || hasOpen}>
                  出題
                </button>
              )}
              {q.status === "open" && (
                <button type="button" className="primary" onClick={() => close(q)} disabled={busy}>
                  締め切る
                </button>
              )}
              {q.status !== "draft" && (
                <button type="button" onClick={() => setResults(q)}>
                  回答者を見る
                </button>
              )}
              <button type="button" onClick={() => setEditing(q)} disabled={busy}>
                編集
              </button>
              {q.status !== "open" && (
                <button type="button" className="danger" onClick={() => remove(q)} disabled={busy}>
                  削除
                </button>
              )}
            </div>
            {q.status === "draft" && hasOpen && <p className="muted small">出題中の問題を締め切ると出題できます。</p>}
          </>
        );
        // 締め切った問題は折りたたみ、見出しに番号・回答数・問題文だけを出す
        if (q.status === "closed") {
          return (
            <details key={q.quizId} className="card quiz-card quiz-closed">
              <summary>
                <span className="quiz-card-header">{header(q, number)}</span>
                <span className="quiz-summary-text">{q.text}</span>
              </summary>
              <p className="quiz-text">{q.text}</p>
              {body}
            </details>
          );
        }
        return (
          <article key={q.quizId} className={`card quiz-card quiz-${q.status}`}>
            <header className="quiz-card-header">{header(q, number)}</header>
            <p className="quiz-text">{q.text}</p>
            {body}
          </article>
        );
      })}
      {editing && (
        <QuizFormDialog
          quiz={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            void load();
          }}
        />
      )}
      {results && <QuizResultsDialog quiz={results} onClose={() => setResults(undefined)} />}
    </section>
  );
}

interface ChoiceDraft {
  /** 既存の選択肢を直すときだけ付く */
  choiceId?: string;
  /** 一覧の key 用（新しい選択肢には choiceId が無いため） */
  key: string;
  text: string;
  points: number;
}

let draftKey = 0;
const newChoice = (points = 0): ChoiceDraft => ({ key: `new-${++draftKey}`, text: "", points });

function QuizFormDialog(props: { quiz?: QuizDto; onClose: () => void; onSaved: () => void }) {
  const { quiz } = props;
  const [text, setText] = useState(quiz?.text ?? "");
  const [choices, setChoices] = useState<ChoiceDraft[]>(
    quiz?.choices.map((ch) => ({ choiceId: ch.choiceId, key: ch.choiceId, text: ch.text, points: ch.points ?? 0 })) ?? [
      newChoice(10),
      newChoice(),
      newChoice(),
    ],
  );
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  // 出題した後は、回答と食い違わないよう選択肢を増やしたり減らしたりできない
  const canChangeChoices = !quiz || quiz.status === "draft";

  function update(key: string, changes: Partial<ChoiceDraft>) {
    setChoices((prev) => prev.map((ch) => (ch.key === key ? { ...ch, ...changes } : ch)));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(undefined);
    const body = { text, choices: choices.map(({ choiceId, text, points }) => ({ choiceId, text, points })) };
    try {
      if (quiz) await api<QuizResponse>("PUT", `/admin/quizzes/${quiz.quizId}`, body);
      else await api<QuizResponse>("POST", "/admin/quizzes", body);
      props.onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const incomplete = choices.some((ch) => Number.isNaN(ch.points));

  return (
    <Modal
      className="dialog quiz-dialog"
      label={quiz ? "問題の編集" : "問題を作る"}
      onClose={props.onClose}
      closable={!saving}
    >
      <form className="card" onSubmit={onSubmit}>
        <h2>{quiz ? "問題の編集" : "問題を作る"}</h2>
        <label className="field">
          <span>問題文</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={QUIZ_TEXT_MAX_LENGTH}
            rows={3}
            required
            data-autofocus
          />
        </label>
        <fieldset className="quiz-form-choices">
          <legend>選択肢と点数</legend>
          {choices.map((ch, i) => (
            <div key={ch.key} className="quiz-form-choice">
              <label className="field">
                <span>選択肢 {i + 1}</span>
                <input
                  value={ch.text}
                  onChange={(e) => update(ch.key, { text: e.target.value })}
                  maxLength={QUIZ_CHOICE_TEXT_MAX_LENGTH}
                  required
                />
              </label>
              <NumberField
                label="点数"
                value={ch.points}
                max={POINTS_MAX}
                onChange={(points) => update(ch.key, { points })}
              />
              {canChangeChoices && (
                <button
                  type="button"
                  className="link"
                  onClick={() => setChoices((prev) => prev.filter((c) => c.key !== ch.key))}
                  disabled={choices.length <= QUIZ_CHOICES_MIN}
                  aria-label={`選択肢 ${i + 1} を削除`}
                >
                  削除
                </button>
              )}
            </div>
          ))}
          {canChangeChoices ? (
            <button
              type="button"
              onClick={() => setChoices((prev) => [...prev, newChoice()])}
              disabled={choices.length >= QUIZ_CHOICES_MAX}
            >
              選択肢を追加
            </button>
          ) : (
            <p className="muted small">
              出題した後は、選択肢の追加・削除はできません。文言と点数は直せます（点数を直すと、締め切った分も数え直します）。
            </p>
          )}
        </fieldset>
        <p className="muted small">正解は 10 点、惜しい答えは 5 点のように、選択肢ごとに点数を決められます。</p>
        {error && <p className="error">{error}</p>}
        {incomplete && <p className="error">点数が空欄の選択肢があります。</p>}
        <div className="buttons">
          <button type="button" onClick={props.onClose} disabled={saving}>
            キャンセル
          </button>
          <button type="submit" className="primary" disabled={saving || incomplete}>
            保存
          </button>
        </div>
      </form>
    </Modal>
  );
}

function QuizResultsDialog(props: { quiz: QuizDto; onClose: () => void }) {
  const [data, setData] = useState<QuizResultsResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api<QuizResultsResponse>("GET", `/admin/quizzes/${props.quiz.quizId}`)
      .then(setData)
      .catch((e) => setError(errorMessage(e)));
  }, [props.quiz.quizId]);

  return (
    <Modal className="dialog quiz-dialog" label="回答者" onClose={props.onClose}>
      <div className="card">
        <h2>回答者</h2>
        <p className="quiz-text">{props.quiz.text}</p>
        {error && <p className="error">{error}</p>}
        {!data && !error && <p className="muted">読み込み中…</p>}
        {data?.quiz.choices.map((ch) => {
          const names = data.answers.filter((a) => a.choiceId === ch.choiceId);
          return (
            <section key={ch.choiceId} className="quiz-result">
              <h3>
                {ch.text}
                <span className="muted small">
                  {" "}
                  {ch.points} 点・{names.length} 人
                </span>
              </h3>
              {names.length > 0 ? (
                <p className="small">{names.map((a) => a.displayName ?? "（不明なユーザ）").join("、")}</p>
              ) : (
                <p className="muted small">なし</p>
              )}
            </section>
          );
        })}
        <div className="buttons">
          <button type="button" onClick={props.onClose}>
            閉じる
          </button>
        </div>
      </div>
    </Modal>
  );
}
