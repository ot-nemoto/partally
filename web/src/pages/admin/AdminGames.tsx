import {
  GAME_CHOICE_TEXT_MAX_LENGTH,
  GAME_CHOICES_MAX,
  GAME_CHOICES_MIN,
  GAME_DESCRIPTION_MAX_LENGTH,
  GAME_FORMAT_LABEL,
  GAME_FORMATS,
  GAME_NAME_MAX_LENGTH,
  GAME_SLOT_NAME_MAX_LENGTH,
  GAME_SLOTS_MAX,
  type GameAnswersResponse,
  type GameDto,
  type GameFormat,
  type GameResponse,
  type GameStatus,
  type GamesResponse,
  POINTS_MAX,
  type TokensResponse,
  type UserDto,
  type UsersResponse,
} from "@partally/shared";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, errorMessage } from "../../api";
import { Modal } from "../../components/Modal";
import { NumberField } from "../../components/NumberField";
import { PageTitle } from "../../components/PageTitle";
import { StatusFilter, useShownStatuses } from "../../components/StatusFilter";
import { useOnReload } from "../../hooks/useReload";

const STATUS_LABEL: Record<GameStatus, string> = { draft: "下書き", open: "開催中", confirmed: "確定" };
/** 表示・非表示を切り替えるボタンの並び */
const STATUSES: GameStatus[] = ["open", "draft", "confirmed"];
/** 保存した直後の一覧の取得が古い内容を返しうる間（一覧は少し遅れて反映される） */
const FRESH_MS = 10_000;

/** 人を選ぶ画面に出す参加者（QR の通し番号つき） */
interface Member {
  user: UserDto;
  /** QR の通し番号。紐づけを解除した人には無い */
  label?: string;
}

/** 更新の本文のうち、ゲームの今の内容（名前・説明・枠・選択肢）。一部だけ変えるときに使う */
function gameBody(game: GameDto) {
  return {
    format: game.format,
    name: game.name,
    description: game.description,
    slots: game.slots.map(({ slotId, name, points, userIds }) => ({ slotId, name, points, userIds })),
    choices: game.choices.map(({ choiceId, text, points }) => ({ choiceId, text, points })),
  };
}

/**
 * ゲーム。形式は「クイズ」（参加者が選択肢から選ぶ）と「結果入力」（幹事が枠ごとに人を選ぶ）。
 * 下書き → 開催中（参加者に知らせる。同時に 1 つだけ）→ 確定（その時刻でポイントが入る）と進める
 */
export function AdminGames() {
  const [games, setGames] = useState<GameDto[]>();
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<GameDto | "new">();
  /** 人を選んでいる枠。ゲームは開くたびに今の一覧から引く（古い内容で上書きしないように） */
  const [picking, setPicking] = useState<{ gameId: string; slotId: string }>();
  const [answers, setAnswers] = useState<GameDto>();
  const [busy, setBusy] = useState(false);
  const { shown, toggle, reveal } = useShownStatuses("partally.admin.gameStatuses", STATUSES);
  /** この画面で削除したゲーム（一覧の読み直しが削除の反映より先に返っても、出し直さない） */
  const deleted = useRef(new Set<string>());
  /** 少し前にこの画面で保存したゲーム（作った直後で一覧にまだ出てこなくても、消さずに残す） */
  const fresh = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      const [g, u, t] = await Promise.all([
        api<GamesResponse>("GET", "/admin/games"),
        api<UsersResponse>("GET", "/admin/users"),
        api<TokensResponse>("GET", "/admin/tokens"),
      ]);
      const labels = new Map(t.tokens.flatMap((tok) => (tok.userId ? [[tok.userId, tok.label] as const] : [])));
      setGames((prev) => mergeGames(prev, g.games, deleted.current, fresh.current));
      setMembers(
        u.users
          .map((user) => ({ user, label: labels.get(user.userId) }))
          .sort(
            (a, b) =>
              (a.label ?? "~").localeCompare(b.label ?? "~") || a.user.createdAt.localeCompare(b.user.createdAt),
          ),
      );
      setError(undefined);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useOnReload(load);

  const byId = useMemo(() => new Map(members.map((m) => [m.user.userId, m.user])), [members]);

  /** 保存したゲームを、一覧の読み直しを待たずに画面へ入れる（続けてほかの枠を選んでも、保存した内容から始める） */
  function saved(game: GameDto) {
    fresh.current.add(game.gameId);
    setTimeout(() => fresh.current.delete(game.gameId), FRESH_MS);
    setGames((prev) => sortGames([...(prev ?? []).filter((g) => g.gameId !== game.gameId), game]));
    reveal(game.status);
    void load();
  }

  const pickingGame = picking && games?.find((g) => g.gameId === picking.gameId);

  /** 開催・確定・取り消しなど。応答のゲームをすぐ画面に入れてから、一覧を読み直す */
  async function run(action: () => Promise<GameResponse | undefined>) {
    setBusy(true);
    try {
      const res = await action();
      if (res) saved(res.game);
      else await load();
    } catch (e) {
      alert(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const post = (g: GameDto, action: string) =>
    run(() => api<GameResponse>("POST", `/admin/games/${g.gameId}/${action}`));
  const confirmGame = (g: GameDto) => {
    const note =
      g.format === "quiz"
        ? `確定すると答えの受付が終わり、選んだ答えの点数（${g.answerCount} 人）がポイントに入ります。`
        : g.slots.some((s) => s.userIds.length > 0)
          ? "確定すると、選んだ人にポイントが入ります。"
          : "まだ誰も選んでいません。";
    if (!confirm(`「${g.name}」を確定します。${note}よろしいですか？`)) return;
    return post(g, "confirm");
  };
  const stopGame = (g: GameDto) => {
    if (
      !confirm(
        `「${g.name}」の開催をやめて下書きに戻します。${g.format === "quiz" ? "答えは残ります。" : ""}よろしいですか？`,
      )
    )
      return;
    return post(g, "stop");
  };
  const unconfirmGame = (g: GameDto) => {
    if (!confirm(`「${g.name}」の確定を取り消して下書きに戻します。入ったポイントも消えます。よろしいですか？`)) return;
    return post(g, "unconfirm");
  };
  const remove = (g: GameDto) => {
    const note =
      g.status === "confirmed" ? "\n入ったポイントも消えます。" : g.answerCount > 0 ? "\n答えも消えます。" : "";
    if (!confirm(`「${g.name}」を削除します。${note}\nよろしいですか？`)) return;
    return run(async () => {
      await api("DELETE", `/admin/games/${g.gameId}`);
      deleted.current.add(g.gameId);
      setGames((prev) => prev?.filter((x) => x.gameId !== g.gameId));
      return undefined;
    });
  };

  const hasOpen = games?.some((g) => g.status === "open") ?? false;
  // 「第 N ゲーム」は作成順の番号。新しいゲームを上にし、選んだ状態のゲームだけを出す
  const numbered = (games ?? []).map((game, i) => ({ game, number: i + 1 }));
  const sorted = numbered.filter(({ game }) => shown.has(game.status)).reverse();
  const counts: Record<GameStatus, number> = { open: 0, draft: 0, confirmed: 0 };
  for (const { game } of numbered) counts[game.status]++;
  // 前に隠した状態が残っていても気づけるよう、隠しているゲームの数を出す
  const hiddenCount = numbered.length - sorted.length;

  return (
    <section className="admin-games">
      <PageTitle en="Game" ja="ゲーム">
        <div className="title-actions">
          {/* 読み込みの前後で固定した行の高さが変わらないよう、ゲームが無くても出しておく */}
          <StatusFilter statuses={STATUSES} labels={STATUS_LABEL} counts={counts} shown={shown} onToggle={toggle} />
          <button type="button" className="primary" onClick={() => setEditing("new")}>
            ゲームを作る
          </button>
        </div>
      </PageTitle>
      <p className="muted small">
        形式は「クイズ」（参加者がスマホで選択肢から選ぶ）と「結果入力」（じゃんけん大会などの結果で、枠ごとに人を選ぶ）。
        「開催する」と参加者の画面にお知らせが出ます（開催中にできるのは 1 つだけ）。「確定」でポイントが入ります。
      </p>
      {error && <p className="error">{error}</p>}
      {games?.length === 0 && <p className="muted">まだゲームがありません。</p>}
      {hiddenCount > 0 && <p className="muted small">{hiddenCount} 件を非表示にしています。</p>}
      {games && games.length > 0 && sorted.length === 0 && (
        <p className="muted">
          {shown.size === 0 ? "表示する状態を選んでください。" : "選んだ状態のゲームはありません。"}
        </p>
      )}
      {sorted.map(({ game: g, number }) => (
        <article key={g.gameId} className={`card game-card game-${g.status}`}>
          <header className="quiz-card-header">
            <span className="muted small">第 {number} ゲーム</span>
            <span className="game-format small">{GAME_FORMAT_LABEL[g.format]}</span>
            <span className={`status status-${g.status}`}>{STATUS_LABEL[g.status]}</span>
            {g.status === "open" && g.format === "quiz" && <span className="muted small">回答 {g.answerCount} 人</span>}
            {g.confirmedAt && <span className="muted small">{formatTime(g.confirmedAt)} に確定</span>}
          </header>
          <h2 className="game-name">{g.name}</h2>
          {g.description && <p className="quiz-text game-description">{g.description}</p>}
          {g.format === "quiz" ? (
            <ul className="quiz-admin-choices">
              {g.choices.map((ch) => (
                <li key={ch.choiceId}>
                  <span>{ch.text}</span>
                  <span className="muted small">{ch.points} 点</span>
                  <span className="num">{ch.answerCount} 人</span>
                </li>
              ))}
            </ul>
          ) : g.slots.length === 0 ? (
            <p className="muted small">まだ枠がありません。「編集」で枠（優勝・準優勝など）を追加してください。</p>
          ) : (
            <ul className="game-slots">
              {g.slots.map((s) => (
                <li key={s.slotId}>
                  <div className="game-slot-head">
                    <strong>{s.name}</strong>
                    <span className="muted small">
                      {s.points} 点・{s.userIds.length} 人
                    </span>
                    <button
                      type="button"
                      onClick={() => setPicking({ gameId: g.gameId, slotId: s.slotId })}
                      disabled={busy}
                      aria-label={`${s.name}の人を選ぶ`}
                    >
                      人を選ぶ
                    </button>
                  </div>
                  {s.userIds.length > 0 ? (
                    <p className="small game-slot-members">
                      {s.userIds.map((id) => byId.get(id)?.displayName ?? "（不明なユーザ）").join("、")}
                    </p>
                  ) : (
                    <p className="muted small game-slot-members">まだ選んでいません</p>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="actions">
            {g.status === "draft" && (
              <button type="button" className="primary" onClick={() => post(g, "open")} disabled={busy || hasOpen}>
                開催する
              </button>
            )}
            {g.status !== "confirmed" && (
              <button
                type="button"
                className={g.status === "open" ? "primary" : undefined}
                onClick={() => confirmGame(g)}
                disabled={busy || (g.format === "result" && g.slots.length === 0)}
                title={g.format === "result" && g.slots.length === 0 ? "枠を追加すると確定できます" : undefined}
              >
                確定
              </button>
            )}
            {g.status === "open" && (
              <button type="button" onClick={() => stopGame(g)} disabled={busy}>
                開催をやめる
              </button>
            )}
            {g.status === "confirmed" && (
              <button type="button" onClick={() => unconfirmGame(g)} disabled={busy}>
                確定を取り消す
              </button>
            )}
            {g.format === "quiz" && g.answerCount > 0 && (
              <button type="button" onClick={() => setAnswers(g)}>
                回答者を見る
              </button>
            )}
            <button type="button" onClick={() => setEditing(g)} disabled={busy}>
              編集
            </button>
            {g.status !== "open" && (
              <button type="button" className="danger" onClick={() => remove(g)} disabled={busy}>
                削除
              </button>
            )}
          </div>
          {g.status === "draft" && hasOpen && (
            <p className="muted small">
              開催中のゲームを確定するか、開催をやめると開催できます。
              {!shown.has("open") && "（開催中のゲームは非表示にしています）"}
            </p>
          )}
        </article>
      ))}
      {editing && (
        <GameFormDialog
          game={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={(game) => {
            setEditing(undefined);
            saved(game);
          }}
          onConflict={() => void load()}
        />
      )}
      {picking && pickingGame?.slots.some((s) => s.slotId === picking.slotId) && (
        <MemberPickerDialog
          game={pickingGame}
          slotId={picking.slotId}
          members={members}
          onClose={() => setPicking(undefined)}
          onSaved={(game) => {
            setPicking(undefined);
            saved(game);
          }}
          onConflict={() => void load()}
        />
      )}
      {answers && <GameAnswersDialog game={answers} onClose={() => setAnswers(undefined)} />}
    </section>
  );
}

/**
 * 読み直した一覧を画面のゲームと合わせる。一覧の取得は保存の直後だと古い内容を返すことがあるので、
 * 画面の方が新しい（updatedAt が後の）ゲームはそのまま残す。この画面で削除したゲームは出さない。
 * fresh は少し前にこの画面で保存したゲーム
 */
function mergeGames(
  prev: GameDto[] | undefined,
  fetched: GameDto[],
  deleted: Set<string>,
  fresh: Set<string>,
): GameDto[] {
  const current = new Map((prev ?? []).map((g) => [g.gameId, g]));
  const merged = fetched
    .filter((g) => !deleted.has(g.gameId))
    .map((g) => {
      const mine = current.get(g.gameId);
      return mine && mine.updatedAt > g.updatedAt ? mine : g;
    });
  // この画面で保存した直後で、まだ一覧に出てこないゲーム（作ったばかり）も残す
  const ids = new Set(merged.map((g) => g.gameId));
  const missing = [...current.values()].filter((g) => !ids.has(g.gameId) && fresh.has(g.gameId));
  return sortGames([...merged, ...missing]);
}

/** 作った順（API の一覧と同じ） */
function sortGames(games: GameDto[]): GameDto[] {
  return games.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.gameId.localeCompare(b.gameId));
}

/** 今日なら時刻だけ、別の日（リハーサルなど）なら日付も付ける */
function formatTime(iso: string) {
  const d = new Date(iso);
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date().toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

/** 枠・選択肢の編集中の行。既存のものを直すときだけ id が付く */
interface RowDraft {
  id?: string;
  /** 一覧の key 用（新しい行には id が無いため） */
  key: string;
  name: string;
  points: number;
  /** 結果入力の枠で選んだ人（クイズの選択肢では空） */
  userIds: string[];
}

let draftKey = 0;
const newRow = (points = 10): RowDraft => ({ key: `new-${++draftKey}`, name: "", points, userIds: [] });

const SLOT_PLACEHOLDERS = ["例: 優勝", "例: 準優勝", "例: ベスト 4"];

function GameFormDialog(props: {
  game?: GameDto;
  onClose: () => void;
  onSaved: (game: GameDto) => void;
  onConflict: () => void;
}) {
  const { game } = props;
  const [format, setFormat] = useState<GameFormat>(game?.format ?? "quiz");
  const [name, setName] = useState(game?.name ?? "");
  const [description, setDescription] = useState(game?.description ?? "");
  // 結果入力は名前だけで作れるよう、枠の行なしで始める。クイズは選択肢 3 つ（最初を 10 点）で始める
  const [slots, setSlots] = useState<RowDraft[]>(
    game?.slots.map((s) => ({ id: s.slotId, key: s.slotId, name: s.name, points: s.points, userIds: s.userIds })) ?? [],
  );
  const [choices, setChoices] = useState<RowDraft[]>(
    game?.choices.map((ch) => ({
      id: ch.choiceId,
      key: ch.choiceId,
      name: ch.text,
      points: ch.points,
      userIds: [],
    })) ?? [newRow(10), newRow(0), newRow(0)],
  );
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const quiz = format === "quiz";
  const rows = quiz ? choices : slots;
  const setRows = quiz ? setChoices : setSlots;
  // 答えと食い違わないよう、クイズの選択肢を増やす・減らすのは、まだ答えが無い下書きの間だけ
  const canChangeRows = !quiz || !game || (game.status === "draft" && game.answerCount === 0);
  const maxRows = quiz ? GAME_CHOICES_MAX : GAME_SLOTS_MAX;
  const minRows = quiz ? GAME_CHOICES_MIN : 0;

  function update(key: string, changes: Partial<RowDraft>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...changes } : r)));
  }

  function move(from: number, to: number) {
    setRows((prev) => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item!);
      return next;
    });
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(undefined);
    const body = {
      format,
      name,
      description,
      slots: quiz ? [] : slots.map((s) => ({ slotId: s.id, name: s.name, points: s.points, userIds: s.userIds })),
      choices: quiz ? choices.map((ch) => ({ choiceId: ch.id, text: ch.name, points: ch.points })) : [],
      // 開いた後にほかで直されていたら、上書きせずに知らせる
      baseUpdatedAt: game?.updatedAt,
    };
    try {
      const res = game
        ? await api<GameResponse>("PUT", `/admin/games/${game.gameId}`, body)
        : await api<GameResponse>("POST", "/admin/games", body);
      props.onSaved(res.game);
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && err.status === 409) props.onConflict();
    } finally {
      setSaving(false);
    }
  }

  const incomplete = rows.some((r) => Number.isNaN(r.points));
  const title = game ? "ゲームの編集" : "ゲームを作る";
  const label = quiz ? "選択肢" : "枠";

  return (
    <Modal className="dialog game-dialog" label={title} onClose={props.onClose} closable={!saving}>
      <form className="card" onSubmit={onSubmit}>
        <h2>{title}</h2>
        {game ? (
          <p className="small">
            形式: <span className="game-format">{GAME_FORMAT_LABEL[format]}</span>
          </p>
        ) : (
          <fieldset className="game-format-choice">
            <legend>形式</legend>
            {GAME_FORMATS.map((f) => (
              <label key={f}>
                <input type="radio" name="format" checked={format === f} onChange={() => setFormat(f)} />
                <span className="game-format-text">
                  <strong>{GAME_FORMAT_LABEL[f]}</strong>
                  <span className="muted small">
                    {f === "quiz"
                      ? "参加者がスマホで選択肢から選び、選んだ答えの点数が入ります"
                      : "じゃんけん大会などの結果で、枠（優勝など）ごとに人を選んで点数を付けます"}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <label className="field">
          <span>名前</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={GAME_NAME_MAX_LENGTH}
            placeholder={quiz ? "例: 第 1 問" : "例: じゃんけん大会"}
            required
            data-autofocus
          />
        </label>
        <label className="field">
          <span>{quiz ? "問題文" : "説明（任意）"}</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={GAME_DESCRIPTION_MAX_LENGTH}
            rows={3}
            placeholder={quiz ? "例: 幹事の出身地は？" : "例: 負けた人は座ってください。最後まで残った人が優勝です"}
          />
          <span className="muted small">参加者のゲームの画面に出ます。</span>
        </label>
        <fieldset className="game-form-slots">
          <legend>{label}と点数</legend>
          {rows.map((r, i) => (
            <div key={r.key} className="game-form-slot">
              <label className="field">
                <span>
                  {label} {i + 1}
                </span>
                <input
                  value={r.name}
                  onChange={(e) => update(r.key, { name: e.target.value })}
                  maxLength={quiz ? GAME_CHOICE_TEXT_MAX_LENGTH : GAME_SLOT_NAME_MAX_LENGTH}
                  placeholder={quiz ? undefined : (SLOT_PLACEHOLDERS[i] ?? "例: 参加賞")}
                  required
                />
              </label>
              <NumberField
                label="点数"
                value={r.points}
                max={POINTS_MAX}
                onChange={(points) => update(r.key, { points })}
              />
              <div className="game-form-slot-actions">
                <button
                  type="button"
                  onClick={() => move(i, i - 1)}
                  disabled={i === 0}
                  aria-label={`${label} ${i + 1} を上へ`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(i, i + 1)}
                  disabled={i === rows.length - 1}
                  aria-label={`${label} ${i + 1} を下へ`}
                >
                  ↓
                </button>
                {canChangeRows && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}
                    disabled={rows.length <= minRows}
                    aria-label={`${label} ${i + 1} を削除`}
                  >
                    削除
                  </button>
                )}
              </div>
              {r.userIds.length > 0 && (
                <p className="muted small game-form-slot-note">選んだ人: {r.userIds.length} 人</p>
              )}
            </div>
          ))}
          {canChangeRows ? (
            <button
              type="button"
              onClick={() => setRows((prev) => [...prev, newRow(quiz ? 0 : 10)])}
              disabled={rows.length >= maxRows}
            >
              {label}を追加
            </button>
          ) : (
            <p className="muted small">
              答えがある・開催した後は、選択肢の追加・削除はできません。文言と点数は直せます（点数を直すと、確定した分も数え直します）。
            </p>
          )}
        </fieldset>
        <p className="muted small">
          {quiz
            ? "正解は 10 点、惜しい答えは 5 点のように、選択肢ごとに点数を決められます。参加者には点数は見せません。"
            : "枠は後から追加することもできます（枠が無いゲームは確定できません）。人は、保存した後に枠ごとの「人を選ぶ」で選びます。枠を削除すると、その枠で選んだ人も外れます。"}
          {game?.status === "confirmed" && "確定済みなので、保存するとすぐにポイントが変わります。"}
        </p>
        {error && <p className="error">{error}</p>}
        {incomplete && <p className="error">点数が空欄の{label}があります。</p>}
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

/** クイズ形式で、だれがどの選択肢を選んだか */
function GameAnswersDialog(props: { game: GameDto; onClose: () => void }) {
  const [data, setData] = useState<GameAnswersResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api<GameAnswersResponse>("GET", `/admin/games/${props.game.gameId}/answers`)
      .then(setData)
      .catch((e) => setError(errorMessage(e)));
  }, [props.game.gameId]);

  return (
    <Modal className="dialog game-dialog" label="回答者" onClose={props.onClose}>
      <div className="card">
        <h2>回答者</h2>
        <p className="small">{props.game.name}</p>
        {props.game.description && <p className="quiz-text">{props.game.description}</p>}
        {error && <p className="error">{error}</p>}
        {!data && !error && <p className="muted">読み込み中…</p>}
        {data?.game.choices.map((ch) => {
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

/**
 * 枠に入る人を選ぶ。名前・二つ名・通し番号で絞り込み、チェックで複数選ぶ。
 * ほかの枠に入っている人を選ぶと、その枠から移す（1 人は 1 つの枠だけ）
 */
function MemberPickerDialog(props: {
  game: GameDto;
  slotId: string;
  members: Member[];
  onClose: () => void;
  onSaved: (game: GameDto) => void;
  /** ほかで直されていて保存できなかったとき（一覧を読み直す） */
  onConflict: () => void;
}) {
  const { slotId } = props;
  // 開いたときのゲームで選び、その版（updatedAt）で保存する。開いている間に一覧が読み直されても、
  // 選び始めた後のほかの変更を、版の確かめをすり抜けて上書きしないように
  const [game] = useState(props.game);
  const slot = game.slots.find((s) => s.slotId === slotId)!;
  const [selected, setSelected] = useState(() => new Set(slot.userIds));
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  /** ほかの枠に入っている人と、その枠の名前 */
  const otherSlot = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of game.slots) if (s.slotId !== slotId) for (const id of s.userIds) map.set(id, s.name);
    return map;
  }, [game, slotId]);

  // 紐づけを解除した人は選べない（この枠に入ったまま解除された人だけは、外せるよう出す）
  const candidates = props.members.filter((m) => m.user.status === "active" || slot.userIds.includes(m.user.userId));
  const q = query.normalize("NFKC").trim().toLowerCase();
  const shown = q
    ? candidates.filter((m) =>
        [m.user.name, m.user.epithet, m.label ?? ""].some((text) => text.normalize("NFKC").toLowerCase().includes(q)),
      )
    : candidates;
  const moving = [...selected].filter((id) => otherSlot.has(id)).length;

  function toggle(userId: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(undefined);
    const slots = game.slots.map((s) => ({
      slotId: s.slotId,
      name: s.name,
      points: s.points,
      userIds: s.slotId === slotId ? [...selected] : s.userIds.filter((id) => !selected.has(id)),
    }));
    try {
      const res = await api<GameResponse>("PUT", `/admin/games/${game.gameId}`, {
        ...gameBody(game),
        slots,
        baseUpdatedAt: game.updatedAt,
      });
      props.onSaved(res.game);
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && err.status === 409) props.onConflict();
    } finally {
      setSaving(false);
    }
  }

  const label = `${game.name}・${slot.name}の人を選ぶ`;

  return (
    <Modal className="dialog game-dialog" label={label} onClose={props.onClose} closable={!saving}>
      <div className="card member-picker">
        <h2>
          {slot.name}
          <span className="muted small">
            {" "}
            {game.name}・{slot.points} 点
          </span>
        </h2>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="名前・二つ名・通し番号で絞り込み"
          aria-label="絞り込み"
          data-autofocus
        />
        <div className="member-picker-bar">
          <span className="small member-picker-count">{selected.size} 人を選択中</span>
          <button
            type="button"
            onClick={() => setSelected((prev) => new Set([...prev, ...shown.map((m) => m.user.userId)]))}
            disabled={shown.length === 0}
          >
            {q ? "表示中の人を全員選ぶ" : "全員を選ぶ"}
          </button>
          <button type="button" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
            選択を外す
          </button>
        </div>
        <ul className="member-list">
          {shown.map(({ user, label: no }) => (
            <li key={user.userId}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.has(user.userId)}
                  onChange={(e) => toggle(user.userId, e.target.checked)}
                />
                <span className="member-no muted small">{no ?? "-"}</span>
                <span className="member-name">{user.displayName}</span>
                {otherSlot.has(user.userId) && (
                  <span className="member-other muted small">{otherSlot.get(user.userId)}</span>
                )}
                {user.status === "unbound" && <span className="member-other muted small">解除済み</span>}
              </label>
            </li>
          ))}
          {shown.length === 0 && <li className="muted small">該当する人がいません。</li>}
        </ul>
        {moving > 0 && <p className="muted small">ほかの枠に入っている {moving} 人は、この枠に移ります。</p>}
        {game.status === "confirmed" && (
          <p className="muted small">確定済みなので、保存するとすぐにポイントが変わります。</p>
        )}
        {error && <p className="error">{error}</p>}
        <div className="buttons">
          <button type="button" onClick={props.onClose} disabled={saving}>
            キャンセル
          </button>
          <button type="button" className="primary" onClick={save} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
