import {
  type CurrentGameDto,
  formatRankRange,
  GAME_KEYWORD_MAX_LENGTH,
  GAME_NUMBER_MAX,
  GAME_NUMBER_MIN,
  type GameAnswerResponse,
  type GameCandidateDto,
} from "@partally/shared";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ApiError, errorMessage } from "../api";
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
 * クイズは選択肢から選び、数値予想は数を入れ、投票は参加者から 1 人を選び、合言葉は言葉を入れ、抽選は参加する
 * （どれも確定されるまで選び直せる・答え直せる）。結果入力は説明と、枠ごとの点数を見せる。
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
  /** 数値予想で入れている数（空欄は NaN） */
  const [value, setValue] = useState(Number.NaN);

  // 別のゲームに変わったら、入れている数をそのゲームの自分の答えにする
  const gameId = game.gameId;
  const myValue = game.myValue;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 答え直すたびには入れ直さない（入力中の数を消さないように）
  useEffect(() => {
    setValue(myValue ?? Number.NaN);
  }, [gameId]);

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
                  onClick={() => onAnswer({ choiceId: ch.choiceId }, ch.choiceId)}
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
      ) : game.format === "lottery" ? (
        <>
          <section className="card game-lottery">
            {game.myEntry ? (
              <>
                <p className="game-keyword-result correct">参加しました</p>
                <p className="muted small">締め切られると抽選し、当たった人にポイントが入ります。</p>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="primary game-lottery-entry"
                  disabled={sending !== undefined}
                  onClick={() => onAnswer({ entry: true }, "entry")}
                >
                  参加する
                </button>
                <p className="muted small">押すと抽選に参加します。締め切られると抽選します。</p>
              </>
            )}
            {error && <p className="error">{error}</p>}
          </section>
          <RankPoints
            ranks={game.ranks}
            unit="等"
            note="締め切られたときに、参加した人の中から無作為に順番を決めます。"
          />
        </>
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
      ) : game.format === "number" ? (
        <>
          <form
            className="card game-number-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!Number.isNaN(value)) void onAnswer({ value }, "value");
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
          <RankPoints
            ranks={game.ranks}
            note="正解に近い順に順位が付き（同じだけ離れた人は同じ順位）、順位に応じた点数が入ります。"
          />
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

/** 順位の範囲ごとの点数（数値予想・投票） */
function RankPoints(props: { ranks: CurrentGameDto["ranks"]; note: string; unit?: string }) {
  return (
    <section className="card">
      {props.ranks.length > 0 ? (
        <ul className="game-points">
          {props.ranks.map((r) => (
            <li key={r.from}>
              <span>{formatRankRange(r, props.unit)}</span>
              <span className="game-award-points">{r.points} 点</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">点数はこれから決まります。</p>
      )}
      <p className="muted small">{props.note}</p>
    </section>
  );
}

/** 絞り込み用に、全角・半角や大文字・小文字の違いをなくす */
const fold = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

/**
 * 投票。選べる人（自分と、紐づけを解除した人を除く全員）は、開いたときと、アプリに戻ったときに読む
 * （5 秒ごとの確認には含めない。途中で参加した人も、戻ったときか「一覧を読み直す」で出る）。
 * 名前・二つ名で絞り込み、押すとその人に投票する（確定されるまで選び直せる）
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
  const [candidates, setCandidates] = useState<GameCandidateDto[]>();
  const [loadError, setLoadError] = useState<string>();
  const [query, setQuery] = useState("");
  const [loadCount, setLoadCount] = useState(0);
  const reload = useCallback(() => setLoadCount((n) => n + 1), []);

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

  // 別のゲームに変わったら、前のゲームの一覧は出さない
  // biome-ignore lint/correctness/useExhaustiveDependencies: gameId が変わったときだけ消す
  useEffect(() => setCandidates(undefined), [game.gameId]);

  // 別のアプリから戻ったら読み直す（途中で参加した人を出す）
  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && reload();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reload]);

  const mine = candidates?.find((c) => c.userId === game.myTargetUserId);
  const q = fold(query);
  const shown = candidates?.filter((c) => fold(c.displayName).includes(q));

  return (
    <>
      <section className="card">
        <p className="small" aria-live="polite">
          {game.myTargetUserId ? (
            <>
              あなたの投票:{" "}
              <strong className="game-vote-mine">
                {mine?.displayName ?? (candidates ? "（今は選べない人）" : "…")}
              </strong>
              <span className="muted">
                {mine || !candidates
                  ? "（締め切りまでは選び直せます）"
                  : "（投票した人が参加をやめました。票はそのまま数えます。選び直すこともできます）"}
              </span>
            </>
          ) : (
            <span className="muted">投票する人を 1 人選んでください。</span>
          )}
        </p>
        <input
          type="search"
          className="game-vote-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="名前・二つ名で探す"
          aria-label="名前・二つ名で探す"
        />
        {props.error && <p className="error">{props.error}</p>}
        {loadError && <p className="error">{loadError}</p>}
        {!candidates && !loadError && <p className="muted">読み込み中…</p>}
        {shown && shown.length === 0 && <p className="muted small">見つかりません。</p>}
        {candidates && (
          <p className="small">
            <button type="button" className="link" onClick={reload}>
              一覧を読み直す
            </button>
            <span className="muted">（後から参加した人を出す）</span>
          </p>
        )}
        <div className="quiz-choices game-vote-list">
          {shown?.map((c) => {
            const selected = game.myTargetUserId === c.userId;
            return (
              <button
                key={c.userId}
                type="button"
                className={selected ? "quiz-choice selected" : "quiz-choice"}
                aria-pressed={selected}
                disabled={props.sending !== undefined}
                onClick={() => props.onVote(c.userId)}
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
      </section>
      <RankPoints
        ranks={game.ranks}
        note={`票の多い順に順位が付き（同じ票数は同じ順位）、選ばれた人に順位に応じた点数が入ります。${
          game.voterPoints > 0 ? `投票した人にも ${game.voterPoints} 点入ります。` : ""
        }誰が誰に投票したかは、ほかの参加者には見えません。`}
      />
    </>
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
          <p className="game-keyword-result correct">正解です！</p>
          <p className="muted small">締め切られると、正解した順に点数が入ります。</p>
        </section>
      ) : (
        <form className="card game-number-form" onSubmit={onSubmit}>
          <label className="field">
            <span>合言葉</span>
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
            送る
          </button>
          {props.error && <p className="error">{props.error}</p>}
          <p className="small" aria-live="polite">
            {result === false ? (
              <span className="game-keyword-result wrong">ちがいます。もう一度どうぞ。</span>
            ) : (
              <span className="muted">見つけた合言葉を入れて「送る」を押してください。何度でも試せます。</span>
            )}
          </p>
        </form>
      )}
      <RankPoints
        ranks={game.ranks}
        unit="番目"
        note="正解した順に番号が付き、番号に応じた点数が入ります。全角・半角、カタカナ・ひらがなの違いは気にしなくて大丈夫です。"
      />
    </>
  );
}
