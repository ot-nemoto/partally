import {
  formatRankRange,
  type GameDto,
  type GameResponse,
  type GameStatus,
  type GamesResponse,
  gameConfirmProblem,
  gameFormatLabel,
  hasGameAnswers,
  hasGameRanks,
  type RoundDto,
  type RoundsResponse,
  rankUnit,
  type TokensResponse,
  type UsersResponse,
} from "@partally/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../api";
import { confirmDialog } from "../../components/ConfirmDialog";
import { PageTitle } from "../../components/PageTitle";
import { StatusFilter, useShownStatuses } from "../../components/StatusFilter";
import { formatRecentTime } from "../../format";
import { useFreshList } from "../../hooks/useFreshList";
import { useOnReload } from "../../hooks/useReload";
import { people, pts, tr, useLang, useT } from "../../i18n";
import { FORMAT_ICON } from "./games/formats";
import { GameAnswersDialog } from "./games/GameAnswersDialog";
import { GameFormDialog } from "./games/GameFormDialog";
import { GamePreviewDialog } from "./games/GamePreviewDialog";
import { type Member, MemberPickerDialog } from "./games/MemberPickerDialog";
import { RoundsSection } from "./games/Rounds";

const STATUS_LABEL: Record<GameStatus, [ja: string, en: string]> = {
  draft: ["下書き", "Draft"],
  open: ["開催中", "Live"],
  confirmed: ["終了", "Ended"],
};

/** 表示・非表示を切り替えるボタンの並び */
const STATUSES: GameStatus[] = ["open", "draft", "confirmed"];

/** 保存した直後の一覧の取得が古い内容を返しうる間（一覧は少し遅れて反映される） */
const FRESH_MS = 10_000;
const roundIdOf = (r: RoundDto) => r.roundId;

/** 「更新」で、もう一度取り直すまでの間 */
const RELOAD_AGAIN_MS = 2_000;

/**
 * ゲーム。形式はクイズ・数値予想・投票・合言葉・抽選・結果入力（アイコンと説明は games/formats.ts）。
 * 下書き →（開始）→ 開催中（参加者に知らせる。同時に 1 つだけ）→（終了）→ 終了（その時刻でポイントが入る）と進める
 */
export function AdminGames() {
  const t = useT();
  const lang = useLang();
  const statusLabels: Record<GameStatus, string> = {
    draft: t(...STATUS_LABEL.draft),
    open: t(...STATUS_LABEL.open),
    confirmed: t(...STATUS_LABEL.confirmed),
  };
  const [games, setGames] = useState<GameDto[]>();
  const [rounds, setRounds] = useState<RoundDto[]>([]);
  // ラウンドも、保存・削除の直後に取り直した一覧が古くても、保存したものを出し、削除したものを出さない
  const roundsFresh = useFreshList(roundIdOf);
  const mergeRounds = roundsFresh.merge;
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<GameDto | "new">();
  /** 人を選んでいる枠。ゲームは開くたびに今の一覧から引く（古い内容で上書きしないように） */
  const [picking, setPicking] = useState<{ gameId: string; slotId: string }>();
  const [answers, setAnswers] = useState<GameDto>();
  const [previewing, setPreviewing] = useState<GameDto>();
  const [busy, setBusy] = useState(false);
  const { shown, toggle, reveal } = useShownStatuses("partally.admin.gameStatuses", STATUSES);
  /** この画面で削除したゲーム（一覧の読み直しが削除の反映より先に返っても、出し直さない） */
  const deleted = useRef(new Set<string>());
  /** 少し前にこの画面で保存したゲーム（作った直後で一覧にまだ出てこなくても、消さずに残す） */
  const fresh = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      const [g, u, t, r] = await Promise.all([
        api<GamesResponse>("GET", "/admin/games"),
        api<UsersResponse>("GET", "/admin/users"),
        api<TokensResponse>("GET", "/admin/tokens"),
        api<RoundsResponse>("GET", "/admin/rounds"),
      ]);
      setRounds(mergeRounds(r.rounds));
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
  }, [mergeRounds]);

  useEffect(() => {
    void load();
  }, [load]);
  // 回答数は答えの一覧から数えるが、一覧は少し遅れて反映される。「更新」では、すぐ取り直したうえで、
  // 少し後にもう一度取り直す（答えた直後に押しても、数が増えるように）
  const reloadTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(reloadTimer.current), []);
  useOnReload(
    useCallback(() => {
      void load();
      clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(() => void load(), RELOAD_AGAIN_MS);
    }, [load]),
  );

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
  const confirmGame = async (g: GameDto) => {
    if (
      !(await confirmDialog(
        tr(`「${g.name}」を終了します。${confirmNote(g)}よろしいですか？`, `End “${g.name}”? ${confirmNote(g)}`),
      ))
    )
      return;
    return post(g, "confirm");
  };
  const stopGame = async (g: GameDto) => {
    if (
      !(await confirmDialog(
        tr(
          `「${g.name}」を中断して下書きに戻します。${hasGameAnswers(g) ? "答えは残ります。" : ""}よろしいですか？`,
          `Pause “${g.name}” and return it to draft?${hasGameAnswers(g) ? " Answers are kept." : ""}`,
        ),
      ))
    )
      return;
    return post(g, "stop");
  };
  const unconfirmGame = async (g: GameDto) => {
    const redraw =
      g.format === "lottery"
        ? tr(
            "\n抽選の結果も消え、開始し直してもう一度終了すると引き直しになります（発表した後は取り消さないでください）。",
            "\nThe draw results are also removed, and starting and ending it again redraws (don’t undo after announcing).",
          )
        : "";
    if (
      !(await confirmDialog(
        tr(
          `「${g.name}」の終了を取り消して下書きに戻します。入ったポイントも消えます。${redraw}\nよろしいですか？`,
          `Undo ending “${g.name}” and return it to draft? The awarded points are removed.${redraw}`,
        ),
      ))
    )
      return;
    return post(g, "unconfirm");
  };
  const remove = async (g: GameDto) => {
    const note =
      g.status === "confirmed"
        ? tr("\n入ったポイントも消えます。", "\nThe awarded points are removed too.")
        : g.storedAnswerCount > 0
          ? tr("\n答えも消えます。", "\nThe answers are removed too.")
          : "";
    if (
      !(await confirmDialog(tr(`「${g.name}」を削除します。${note}\nよろしいですか？`, `Delete “${g.name}”?${note}`)))
    )
      return;
    return run(async () => {
      await api("DELETE", `/admin/games/${g.gameId}`);
      deleted.current.add(g.gameId);
      setGames((prev) => prev?.filter((x) => x.gameId !== g.gameId));
      return undefined;
    });
  };

  const hasOpen = games?.some((g) => g.status === "open") ?? false;
  const roundName = new Map(rounds.map((r) => [r.roundId, r.name]));
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
          <StatusFilter statuses={STATUSES} labels={statusLabels} counts={counts} shown={shown} onToggle={toggle} />
          <button type="button" className="primary" onClick={() => setEditing("new")}>
            {t("ゲームを作る", "New game")}
          </button>
        </div>
      </PageTitle>
      <p className="muted small">
        {t(
          "形式は「クイズ」「数値予想」「投票」「合言葉」「抽選」「結果入力」から選べます（それぞれの説明は「ゲームを作る」に出ます）。「開始」と参加者の画面にお知らせが出ます（開催中にできるのは 1 問か 1 ラウンドのどちらか 1 つだけ）。「終了」でポイントが入ります。",
          "Choose a format: Quiz, Number guess, Vote, Keyword, Lottery or Result entry (each is explained in “New game”). “Start” shows a notice on participants’ screens (only one game or one round can be live at a time). “End” awards the points.",
        )}
      </p>
      {error && <p className="error">{error}</p>}
      {games && (
        <RoundsSection
          rounds={rounds}
          games={games}
          hasOpen={hasOpen}
          onChanged={load}
          onSaved={(round) => {
            roundsFresh.saved(round);
            setRounds((prev) => roundsFresh.merge(prev));
          }}
          onRemoved={(roundId) => {
            roundsFresh.removed(roundId);
            setRounds((prev) => roundsFresh.merge(prev));
          }}
        />
      )}
      {games?.length === 0 && <p className="muted">{t("まだゲームがありません。", "No games yet.")}</p>}
      {hiddenCount > 0 && (
        <p className="muted small">{t(`${hiddenCount} 件を非表示にしています。`, `${hiddenCount} hidden.`)}</p>
      )}
      {games && games.length > 0 && sorted.length === 0 && (
        <p className="muted">
          {shown.size === 0
            ? t("表示する状態を選んでください。", "Choose which statuses to show.")
            : t("選んだ状態のゲームはありません。", "No games with the chosen statuses.")}
        </p>
      )}
      {sorted.map(({ game: g, number }) => (
        <article key={g.gameId} className={`card game-card game-${g.status}`}>
          <header className="quiz-card-header">
            <span className="muted small">{t(`第 ${number} ゲーム`, `Game ${number}`)}</span>
            <span className="game-format small">
              <span aria-hidden="true">{FORMAT_ICON[g.format]} </span>
              {gameFormatLabel(g.format, lang)}
            </span>
            <span className={`status status-${g.status}`}>{t(...STATUS_LABEL[g.status])}</span>
            {g.status === "open" && hasGameAnswers(g) && (
              <span className="muted small">
                {g.format === "keyword"
                  ? t(`正解 ${g.answerCount} 人`, `${g.answerCount} correct`)
                  : g.format === "lottery"
                    ? t(`参加 ${g.answerCount} 人`, `${g.answerCount} entered`)
                    : t(`回答 ${g.answerCount} 人`, `${g.answerCount} answered`)}
              </span>
            )}
            {g.confirmedAt && (
              <span className="muted small">
                {t(`${formatRecentTime(g.confirmedAt)} に終了`, `Ended at ${formatRecentTime(g.confirmedAt)}`)}
              </span>
            )}
            {/* ラウンドに入っているゲームは、ラウンドで開始・終了する */}
            {g.roundId && (
              <span className="game-round-chip small">
                {t(`ラウンド「${roundName.get(g.roundId) ?? ""}」`, `Round “${roundName.get(g.roundId) ?? ""}”`)}
              </span>
            )}
            {/* 進行のボタン（下書きは開始、開催中は同じ位置に終了）はカードの右上に置く */}
            {!g.roundId && g.status === "draft" && (
              <button
                type="button"
                className="primary game-start"
                onClick={() => post(g, "open")}
                disabled={busy || hasOpen}
              >
                {t("開始", "Start")}
              </button>
            )}
            {!g.roundId && g.status === "open" && (
              <button
                type="button"
                className="primary game-start"
                onClick={() => confirmGame(g)}
                disabled={busy || gameConfirmProblem(g) !== undefined}
                title={gameConfirmProblem(g, lang)}
              >
                {t("終了", "End")}
              </button>
            )}
          </header>
          <h2 className="game-name">{g.name}</h2>
          {g.imageUrl && <img className="game-image" src={g.imageUrl} alt="" loading="lazy" />}
          {g.description && <p className="quiz-text game-description">{g.description}</p>}
          {g.format === "quiz" ? (
            <ul className="quiz-admin-choices">
              {g.choices.map((ch) => (
                <li key={ch.choiceId}>
                  <span className="game-choice-label">
                    {ch.imageUrl && <img className="game-choice-thumb" src={ch.imageUrl} alt="" loading="lazy" />}
                    {ch.text}
                  </span>
                  <span className="muted small">{t(`${ch.points} 点`, pts(ch.points))}</span>
                  <span className="num">{t(`${ch.answerCount} 人`, people(ch.answerCount))}</span>
                </li>
              ))}
            </ul>
          ) : hasGameRanks(g) ? (
            <>
              {g.format === "number" && (
                <p className="small game-number-correct">
                  {t("正解の数: ", "Correct number: ")}
                  {g.correctNumber === undefined ? (
                    <span className="muted">
                      {t("未設定（「編集」で入れると終了できます）", "Not set (enter it in “Edit” to end it)")}
                    </span>
                  ) : (
                    <strong>{g.correctNumber}</strong>
                  )}
                </p>
              )}
              {g.format === "vote" && (
                <p className="small game-number-correct">
                  {t("投票した人に: ", "To each voter: ")}
                  <strong>{t(`${g.voterPoints} 点`, pts(g.voterPoints))}</strong>
                </p>
              )}
              {g.format === "keyword" && (
                <p className="small game-number-correct">
                  {t("合言葉: ", "Keyword: ")}
                  <strong>{g.keyword}</strong>
                </p>
              )}
              {g.ranks.length === 0 ? (
                <p className="muted small">
                  {t(
                    "まだ点数の範囲がありません。「編集」で追加してください。",
                    "No points ranges yet. Add them in “Edit”.",
                  )}
                </p>
              ) : (
                <ul className="quiz-admin-choices">
                  {g.ranks.map((r) => (
                    <li key={r.from}>
                      <span>{formatRankRange(r, rankUnit(g.format), lang)}</span>
                      <span className="muted small">{t(`${r.points} 点`, pts(r.points))}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : g.slots.length === 0 ? (
            <p className="muted small">
              {t(
                "まだ枠がありません。「編集」で枠（優勝・準優勝など）を追加してください。",
                "No slots yet. Add slots (winner, runner-up, etc.) in “Edit”.",
              )}
            </p>
          ) : (
            <ul className="game-slots">
              {g.slots.map((s) => (
                <li key={s.slotId}>
                  <div className="game-slot-head">
                    <strong>{s.name}</strong>
                    <span className="muted small">
                      {t(`${s.points} 点・${s.userIds.length} 人`, `${pts(s.points)} · ${people(s.userIds.length)}`)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPicking({ gameId: g.gameId, slotId: s.slotId })}
                      disabled={busy}
                      aria-label={t(`${s.name}の人を選ぶ`, `Choose people for ${s.name}`)}
                    >
                      {t("人を選ぶ", "Choose people")}
                    </button>
                  </div>
                  {s.userIds.length > 0 ? (
                    <p className="small game-slot-members">
                      {s.userIds
                        .map((id) => byId.get(id)?.displayName ?? t("（不明なユーザ）", "(unknown user)"))
                        .join(t("、", ", "))}
                    </p>
                  ) : (
                    <p className="muted small game-slot-members">{t("まだ選んでいません", "No one chosen yet")}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="actions game-actions">
            {/* 削除（開催中は中断）はほかのボタンから離して左端に置く（押し間違えないように） */}
            {g.status !== "open" && (
              <button type="button" className="danger game-actions-left" onClick={() => remove(g)} disabled={busy}>
                {t("削除", "Delete")}
              </button>
            )}
            {!g.roundId && g.status === "open" && (
              <button type="button" className="game-actions-left" onClick={() => stopGame(g)} disabled={busy}>
                {t("中断", "Pause")}
              </button>
            )}
            {!g.roundId && g.status === "confirmed" && (
              <button type="button" onClick={() => unconfirmGame(g)} disabled={busy}>
                {t("終了を取り消す", "Undo end")}
              </button>
            )}
            <button type="button" onClick={() => setPreviewing(g)}>
              {t("プレビュー", "Preview")}
            </button>
            {hasGameAnswers(g) && g.storedAnswerCount > 0 && (
              <button type="button" onClick={() => setAnswers(g)}>
                {t("回答者を見る", "Answers")}
              </button>
            )}
            <button type="button" onClick={() => setEditing(g)} disabled={busy}>
              {t("編集", "Edit")}
            </button>
          </div>
          {g.status === "draft" && hasOpen && (
            <p className="muted small">
              {t(
                "開催中のゲームを終了するか中断すると、開始できます。",
                "End or pause the live game to start this one.",
              )}
              {!shown.has("open") && t("（開催中のゲームは非表示にしています）", " (the live game is hidden)")}
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
      {previewing && (
        <GamePreviewDialog
          game={previewing}
          members={members.map((m) => m.user)}
          onClose={() => setPreviewing(undefined)}
        />
      )}
    </section>
  );
}

/** 確定するときの確認の文（何にポイントが入るか） */
function confirmNote(g: GameDto): string {
  switch (g.format) {
    case "quiz":
      return tr(
        `終了すると答えの受付が終わり、選んだ答えの点数（${g.answerCount} 人）がポイントに入ります。`,
        `Answers close, and the points of each chosen answer (${people(g.answerCount)}) are awarded.`,
      );
    case "number":
      return tr(
        `終了すると答えの受付が終わり、正解 ${g.correctNumber} に近い順の順位で点数（${g.answerCount} 人）がポイントに入ります。`,
        `Answers close, and points are awarded by how close each guess is to ${g.correctNumber} (${people(g.answerCount)}).`,
      );
    case "vote":
      return tr(
        `終了すると投票の受付が終わり、得票の順位で選ばれた人（投票 ${g.answerCount} 人）にポイントが入ります。`,
        `Voting closes, and the people voted for get points by vote ranking (${g.answerCount} ${g.answerCount === 1 ? "vote" : "votes"}).`,
      );
    case "keyword":
      return tr(
        `終了すると受付が終わり、正解した順で点数（正解 ${g.answerCount} 人）がポイントに入ります。`,
        `Entries close, and points are awarded in the order of correct answers (${g.answerCount} correct).`,
      );
    case "lottery":
      return tr(
        `終了すると受付が終わり、参加した ${g.answerCount} 人から抽選して、当たった人にポイントが入ります。`,
        `Entries close, a draw is made from ${g.answerCount} ${g.answerCount === 1 ? "entrant" : "entrants"}, and the winners get points.`,
      );
    default:
      return g.slots.some((s) => s.userIds.length > 0)
        ? tr("終了すると、選んだ人にポイントが入ります。", "The chosen people get points.")
        : tr("まだ誰も選んでいません。", "No one has been chosen yet.");
  }
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
