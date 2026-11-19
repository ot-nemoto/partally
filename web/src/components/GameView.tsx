import {
  type CurrentGameDto,
  GAME_KEYWORD_MAX_LENGTH,
  GAME_NUMBER_MAX,
  GAME_NUMBER_MIN,
  type GameAnswerResponse,
  type GameCandidateDto,
} from "@partally/shared";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ApiError, errorMessage } from "../api";
import { useT } from "../i18n";
import { NumberField } from "./NumberField";

/** 参加者がゲームに送る答え */
export type GameAnswerBody =
  | { choiceId: string }
  | { value: number }
  | { targetUserId: string }
  | { text: string }
  | { entry: true };

/**
 * 開催中のゲームの画面の中身（参加者の画面と、管理画面のプレビューで共通）。
 * クイズは選択肢から選び、数値予想は数を入れ、投票は参加者から 1 人を選んで「決定」で送る（送った後は答え直せない）。
 * 合言葉は言葉を入れて送り（正解するまで送り直せる）、抽選は参加する。答えたら「対応済み」のスタンプを出す。結果入力は名前と説明だけ。
 * 答えは onAnswer に渡す（参加者の画面は API に送り、プレビューは送らない）
 */
export function GameView(props: {
  game: CurrentGameDto;
  /** 送っている答えの印（送っている間はボタンを押せない） */
  sending?: string;
  error?: string;
  onAnswer: (body: GameAnswerBody, key: string) => Promise<GameAnswerResponse | undefined>;
  /** 投票で選べる人を読む */
  loadCandidates: () => Promise<GameCandidateDto[]>;
  /** 投票の候補を読もうとしたら、もう終わっていたとき */
  onClosed: () => void;
}) {
  const { game, sending, error, onAnswer } = props;
  const t = useT();
  /** 数値予想で入れている数（空欄は NaN） */
  const [value, setValue] = useState(Number.NaN);
  /** クイズで選んでいる選択肢（「決定」を押すまで送らない） */
  const [picked, setPicked] = useState<string>();

  // 別のゲームに変わったら、入れている数と選んでいる選択肢を消す
  const gameId = game.gameId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: gameId が変わったときだけ消す
  useEffect(() => {
    setValue(Number.NaN);
    setPicked(undefined);
  }, [gameId]);

  return (
    <>
      <h1>{game.name}</h1>
      {(game.imageUrl || game.description) && (
        <section className="card">
          {game.imageUrl && <img className="game-image" src={game.imageUrl} alt={t("問題の画像", "Question image")} />}
          {game.description && <p className="quiz-text">{game.description}</p>}
        </section>
      )}
      {game.format === "quiz" ? (
        <>
          <div className={game.choices.some((ch) => ch.imageUrl) ? "quiz-choices with-images" : "quiz-choices"}>
            {game.choices.map((ch) => {
              const selected = (game.myChoiceId ?? picked) === ch.choiceId;
              return (
                <button
                  key={ch.choiceId}
                  type="button"
                  className={selected ? "quiz-choice selected" : "quiz-choice"}
                  aria-pressed={selected}
                  disabled={sending !== undefined || game.myChoiceId !== undefined}
                  onClick={() => setPicked(ch.choiceId)}
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
          {game.myChoiceId !== undefined ? (
            <DoneStamp />
          ) : (
            <DecideButton
              disabled={sending !== undefined || picked === undefined}
              onClick={() => picked && onAnswer({ choiceId: picked }, picked)}
            />
          )}
        </>
      ) : game.format === "lottery" ? (
        <section className="card game-lottery">
          {game.myEntry ? (
            <>
              <p className="game-keyword-result correct">{t("参加しました", "You’re in")}</p>
              <DoneStamp />
            </>
          ) : (
            <button
              type="button"
              className="primary game-lottery-entry"
              disabled={sending !== undefined}
              onClick={() => onAnswer({ entry: true }, "entry")}
            >
              {t("参加する", "Enter")}
            </button>
          )}
          {error && <p className="error">{error}</p>}
        </section>
      ) : game.format === "keyword" ? (
        <KeywordSection
          game={game}
          sending={sending !== undefined}
          error={error}
          onSend={(text) => onAnswer({ text }, "text")}
        />
      ) : game.format === "vote" ? (
        <VoteSection
          game={game}
          sending={sending}
          error={error}
          onVote={(userId) => onAnswer({ targetUserId: userId }, userId)}
          loadCandidates={props.loadCandidates}
          onClosed={props.onClosed}
        />
      ) : game.format === "number" && game.myValue !== undefined ? (
        <section className="card">
          <p aria-live="polite">
            {t("あなたの答え: ", "Your answer: ")}
            <strong className="game-number-mine">{game.myValue}</strong>
          </p>
          <DoneStamp />
        </section>
      ) : game.format === "number" ? (
        <form
          className="card game-number-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!Number.isNaN(value)) void onAnswer({ value }, "value");
          }}
        >
          <NumberField
            label={t("予想する数", "Your guess")}
            value={value}
            min={GAME_NUMBER_MIN}
            max={GAME_NUMBER_MAX}
            onChange={setValue}
          />
          <button type="submit" className="primary game-decide" disabled={sending !== undefined || Number.isNaN(value)}>
            {t("決定", "Submit")}
          </button>
          {error && <p className="error">{error}</p>}
        </form>
      ) : null}
    </>
  );
}

/** 選んだ答えを送るボタン。送った後は答え直せない */
function DecideButton(props: { disabled: boolean; onClick: () => void }) {
  const t = useT();
  return (
    <button type="button" className="primary game-decide" disabled={props.disabled} onClick={props.onClick}>
      {t("決定", "Submit")}
    </button>
  );
}

/** 答えた（参加した）印 */
function DoneStamp() {
  const t = useT();
  return (
    <p className="game-done-stamp" role="status">
      {t("対応済み", "Completed")}
    </p>
  );
}

/** 絞り込み用に、全角・半角や大文字・小文字の違いをなくす */
const fold = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

/**
 * 投票。選べる人（自分と、紐づけを解除した人を除く全員）は、開いたときと、アプリに戻ったときに読む
 * （5 秒ごとの確認には含めない。途中で参加した人は、アプリに戻ったときに出る）。
 * 名前・二つ名で絞り込み、押して選び、「決定」で投票する（投票した後は選び直せない）
 */
function VoteSection(props: {
  game: CurrentGameDto;
  sending?: string;
  error?: string;
  onVote: (userId: string) => void;
  loadCandidates: () => Promise<GameCandidateDto[]>;
  onClosed: () => void;
}) {
  const { game, onClosed, loadCandidates } = props;
  const t = useT();
  const [candidates, setCandidates] = useState<GameCandidateDto[]>();
  const [loadError, setLoadError] = useState<string>();
  const [query, setQuery] = useState("");
  const [loadCount, setLoadCount] = useState(0);
  const reload = useCallback(() => setLoadCount((n) => n + 1), []);
  /** 選んでいる人（「決定」を押すまで送らない） */
  const [picked, setPicked] = useState<string>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadCount は読み直しの合図
  useEffect(() => {
    let active = true;
    setLoadError(undefined);
    loadCandidates()
      .then((res) => active && setCandidates(res))
      .catch((e) => {
        if (!active) return;
        if (e instanceof ApiError && e.code === "game_closed") onClosed();
        else setLoadError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [game.gameId, onClosed, loadCandidates, loadCount]);

  // 別のゲームに変わったら、前のゲームの一覧と選んでいる人は消す
  // biome-ignore lint/correctness/useExhaustiveDependencies: gameId が変わったときだけ消す
  useEffect(() => {
    setCandidates(undefined);
    setPicked(undefined);
  }, [game.gameId]);

  // 別のアプリから戻ったら読み直す（途中で参加した人を出す）
  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && reload();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reload]);

  const mine = candidates?.find((c) => c.userId === game.myTargetUserId);
  const q = fold(query);
  const shown = candidates?.filter((c) => fold(c.displayName).includes(q));

  if (game.myTargetUserId) {
    return (
      <section className="card">
        <p aria-live="polite">
          {t("あなたの投票: ", "Your vote: ")}
          <strong className="game-vote-mine">
            {mine?.displayName ?? (candidates ? t("（今は選べない人）", "(someone you can’t choose now)") : "…")}
          </strong>
          {!mine && candidates && (
            <span className="muted small">
              {t(
                "（投票した人が参加をやめました。票はそのまま数えます）",
                " (this person has left. Your vote still counts)",
              )}
            </span>
          )}
        </p>
        <DoneStamp />
      </section>
    );
  }

  const pickedName = candidates?.find((c) => c.userId === picked)?.displayName;
  return (
    <section className="card">
      <input
        type="search"
        className="game-vote-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("名前・二つ名で探す", "Search by name or title")}
        aria-label={t("名前・二つ名で探す", "Search by name or title")}
      />
      {loadError && <p className="error">{loadError}</p>}
      {!candidates && !loadError && <p className="muted">{t("読み込み中…", "Loading…")}</p>}
      {shown && shown.length === 0 && <p className="muted small">{t("見つかりません。", "No one found.")}</p>}
      <div className="quiz-choices game-vote-list">
        {shown?.map((c) => {
          const selected = picked === c.userId;
          return (
            <button
              key={c.userId}
              type="button"
              className={selected ? "quiz-choice selected" : "quiz-choice"}
              aria-pressed={selected}
              disabled={props.sending !== undefined}
              onClick={() => setPicked(c.userId)}
            >
              <span className="quiz-choice-text">
                <span className="quiz-check" aria-hidden="true">
                  {selected ? "✓" : ""}
                </span>
                <span>{c.displayName}</span>
              </span>
            </button>
          );
        })}
      </div>
      {/* 一覧が長くても押せるよう、決定は画面の下に留める */}
      <div className="game-decide-bar">
        {props.error && <p className="error">{props.error}</p>}
        {pickedName && <p className="small game-vote-picked">{pickedName}</p>}
        <DecideButton
          disabled={props.sending !== undefined || pickedName === undefined}
          onClick={() => picked && props.onVote(picked)}
        />
      </div>
    </section>
  );
}

/** 合言葉。入れて送ると、その場で正解か分かる（不正解なら何度でも。正解した後は送らない） */
function KeywordSection(props: {
  game: CurrentGameDto;
  sending: boolean;
  error?: string;
  onSend: (text: string) => Promise<GameAnswerResponse | undefined>;
}) {
  const { game } = props;
  const t = useT();
  const [text, setText] = useState("");
  /** 直前に送った言葉が正解だったか（まだ送っていなければ undefined） */
  const [result, setResult] = useState<boolean>();

  // 別のゲームに変わったら、入力と結果を消す
  // biome-ignore lint/correctness/useExhaustiveDependencies: gameId が変わったときだけ消す
  useEffect(() => {
    setText("");
    setResult(undefined);
  }, [game.gameId]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    const res = await props.onSend(text);
    if (res?.correct === undefined) return;
    // 不正解でも入れた言葉は残す（打ち間違いを直して送り直せるように）
    setResult(res.correct);
  }

  return (
    <>
      {game.myKeywordCorrect ? (
        <section className="card game-keyword-done">
          <p className="game-keyword-result correct">{t("正解です！", "Correct!")}</p>
          <DoneStamp />
        </section>
      ) : (
        <form className="card game-number-form" onSubmit={onSubmit}>
          <label className="field">
            <span>{t("合言葉", "Keyword")}</span>
            <input
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setResult(undefined);
              }}
              maxLength={GAME_KEYWORD_MAX_LENGTH}
              autoComplete="off"
              enterKeyHint="send"
              required
            />
          </label>
          <button type="submit" className="primary" disabled={props.sending || !text.trim()}>
            {t("送る", "Send")}
          </button>
          {props.error && <p className="error">{props.error}</p>}
          <p className="small" aria-live="polite">
            {result === false && (
              <span className="game-keyword-result wrong">
                {t("ちがいます。もう一度どうぞ。", "Not quite. Try again.")}
              </span>
            )}
          </p>
        </form>
      )}
    </>
  );
}
