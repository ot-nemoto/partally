import {
  type GameDto,
  type GameStatus,
  gameConfirmProblem,
  gameFormatLabel,
  ROUND_GAMES_MAX,
  ROUND_NAME_MAX_LENGTH,
  type RoundDto,
  type RoundResponse,
  type RoundsResponse,
} from "@partally/shared";
import { type FormEvent, useState } from "react";
import { api, errorMessage } from "../../../api";
import { Modal } from "../../../components/Modal";
import { formatRecentTime } from "../../../format";
import { tr, useLang, useT } from "../../../i18n";
import { FORMAT_ICON } from "./formats";

const STATUS_LABEL: Record<GameStatus, [ja: string, en: string]> = {
  draft: ["下書き", "Draft"],
  open: ["開催中", "Live"],
  confirmed: ["終了", "Ended"],
};

/**
 * ラウンド（複数のゲームをまとめて開始・終了する単位）の一覧。準備でゲームを入れておき、当日は右上の開始・終了だけで進める。
 * 操作の後は onChanged でゲームとラウンドを読み直す
 */
export function RoundsSection(props: {
  rounds: RoundDto[];
  games: GameDto[];
  /** ゲームかラウンドが開催中（開始できない） */
  hasOpen: boolean;
  onChanged: () => Promise<void>;
  /** 保存・状態を変えたラウンドを、一覧の取り直しを待たずに画面へ入れる */
  onSaved: (round: RoundDto) => void;
  /** 削除したラウンドを、一覧の取り直しを待たずに画面から外す */
  onRemoved: (roundId: string) => void;
}) {
  const { rounds, games } = props;
  const t = useT();
  const lang = useLang();
  const [editing, setEditing] = useState<RoundDto | "new">();
  const [busy, setBusy] = useState(false);
  const byId = new Map(games.map((g) => [g.gameId, g]));
  const gamesOf = (r: RoundDto) => r.gameIds.flatMap((id) => byId.get(id) ?? []);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      alert(errorMessage(e));
    } finally {
      await props.onChanged();
      setBusy(false);
    }
  }
  const post = (r: RoundDto, action: string) =>
    run(async () => props.onSaved((await api<RoundResponse>("POST", `/admin/rounds/${r.roundId}/${action}`)).round));

  const start = (r: RoundDto) => {
    if (
      !confirm(
        tr(
          `「${r.name}」を開始し、${r.gameIds.length} 問を参加者に出します。よろしいですか？`,
          `Start “${r.name}” and show ${r.gameIds.length} questions to participants?`,
        ),
      )
    )
      return;
    return post(r, "open");
  };
  const end = (r: RoundDto) => {
    const problems = gamesOf(r).flatMap((g) => {
      const p = gameConfirmProblem(g, lang);
      return p ? [`「${g.name}」: ${p}`] : [];
    });
    if (problems.length > 0) {
      alert(
        tr(
          `終了できない問題があります。\n${problems.join("\n")}`,
          `Some questions can’t be ended.\n${problems.join("\n")}`,
        ),
      );
      return;
    }
    if (
      !confirm(
        tr(
          `「${r.name}」の ${r.gameIds.length} 問をまとめて終了し、ポイントを入れます。よろしいですか？`,
          `End all ${r.gameIds.length} questions in “${r.name}” and award points?`,
        ),
      )
    )
      return;
    return post(r, "confirm");
  };
  const pause = (r: RoundDto) => {
    if (
      !confirm(
        tr(
          `「${r.name}」を中断して、全問を下書きに戻します。答えは残ります。よろしいですか？`,
          `Pause “${r.name}” and return all questions to draft? Answers are kept.`,
        ),
      )
    )
      return;
    return post(r, "stop");
  };
  const undo = (r: RoundDto) => {
    if (
      !confirm(
        tr(
          `「${r.name}」の終了を取り消して、全問を下書きに戻します。入ったポイントも消えます。よろしいですか？`,
          `Undo ending “${r.name}” and return all questions to draft? The awarded points are removed.`,
        ),
      )
    )
      return;
    return post(r, "unconfirm");
  };
  const remove = (r: RoundDto) => {
    if (
      !confirm(
        tr(
          `ラウンド「${r.name}」を削除します（中のゲームは残ります）。よろしいですか？`,
          `Delete the round “${r.name}”? (Its games are kept.)`,
        ),
      )
    )
      return;
    return run(async () => {
      await api("DELETE", `/admin/rounds/${r.roundId}`);
      props.onRemoved(r.roundId);
    });
  };
  const move = (index: number, delta: number) => {
    const ids = rounds.map((r) => r.roundId);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + delta, 0, moved!);
    return run(() => api<RoundsResponse>("PUT", "/admin/rounds/order", { roundIds: ids }));
  };

  return (
    <section className="rounds">
      <div className="rounds-head">
        <h2>{t("ラウンド", "Rounds")}</h2>
        <button type="button" onClick={() => setEditing("new")}>
          {t("ラウンドを作る", "New round")}
        </button>
      </div>
      <p className="muted small">
        {t(
          "複数のゲームをまとめて出すときに使います。準備でゲームを入れておき、当日は右上の「開始」で全問を出し、「終了」で全問をまとめて終了します。ラウンドに入れたゲームは、1 問だけでは開始・終了できません。",
          "Use rounds to show several games at once. Add games while preparing; on the day, “Start” shows all questions and “End” ends them all together. Games in a round can’t be started or ended on their own.",
        )}
      </p>
      {rounds.map((r, i) => {
        const inRound = gamesOf(r);
        return (
          <article key={r.roundId} className={`card round-card game-${r.status}`}>
            <header className="quiz-card-header">
              <span className={`status status-${r.status}`}>{t(...STATUS_LABEL[r.status])}</span>
              <span className="muted small">{t(`${r.gameIds.length} 問`, `${r.gameIds.length} questions`)}</span>
              {r.confirmedAt && (
                <span className="muted small">
                  {t(`${formatRecentTime(r.confirmedAt)} に終了`, `Ended at ${formatRecentTime(r.confirmedAt)}`)}
                </span>
              )}
              {r.status === "draft" && (
                <button
                  type="button"
                  className="primary game-start"
                  onClick={() => start(r)}
                  disabled={busy || props.hasOpen || r.gameIds.length === 0}
                  title={r.gameIds.length === 0 ? t("ゲームを入れてください", "Add games first") : undefined}
                >
                  {t("開始", "Start")}
                </button>
              )}
              {r.status === "open" && (
                <button type="button" className="primary game-start" onClick={() => end(r)} disabled={busy}>
                  {t("終了", "End")}
                </button>
              )}
            </header>
            <h3 className="game-name">{r.name}</h3>
            {inRound.length === 0 ? (
              <p className="muted small">
                {t("まだゲームが入っていません。「編集」で入れてください。", "No games yet. Add them in “Edit”.")}
              </p>
            ) : (
              <ol className="round-card-games">
                {inRound.map((g) => (
                  <li key={g.gameId}>
                    <span aria-hidden="true">{FORMAT_ICON[g.format]} </span>
                    {g.name}
                    <span className="muted small">
                      {t(`（${gameFormatLabel(g.format, lang)}）`, ` (${gameFormatLabel(g.format, lang)})`)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            <div className="actions game-actions">
              {r.status === "open" ? (
                <button type="button" className="game-actions-left" onClick={() => pause(r)} disabled={busy}>
                  {t("中断", "Pause")}
                </button>
              ) : (
                <button type="button" className="danger game-actions-left" onClick={() => remove(r)} disabled={busy}>
                  {t("削除", "Delete")}
                </button>
              )}
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={busy || i === 0}
                aria-label={t("上へ", "Move up")}
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={busy || i === rounds.length - 1}
                aria-label={t("下へ", "Move down")}
              >
                ↓
              </button>
              {r.status === "confirmed" && (
                <button type="button" onClick={() => undo(r)} disabled={busy}>
                  {t("終了を取り消す", "Undo end")}
                </button>
              )}
              <button type="button" onClick={() => setEditing(r)} disabled={busy}>
                {t("編集", "Edit")}
              </button>
            </div>
          </article>
        );
      })}
      {editing && (
        <RoundDialog
          round={editing === "new" ? undefined : editing}
          rounds={rounds}
          games={games}
          onClose={() => setEditing(undefined)}
          onSaved={async (round) => {
            setEditing(undefined);
            props.onSaved(round);
            await props.onChanged();
          }}
        />
      )}
    </section>
  );
}

/** ラウンドの作成・編集。名前と、入れるゲーム（出す順）を決める。開始中・終了済みは名前だけ直せる */
function RoundDialog(props: {
  round?: RoundDto;
  rounds: RoundDto[];
  games: GameDto[];
  onClose: () => void;
  onSaved: (round: RoundDto) => Promise<void>;
}) {
  const t = useT();
  const lang = useLang();
  const [name, setName] = useState(props.round?.name ?? "");
  const [gameIds, setGameIds] = useState<string[]>(props.round?.gameIds ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const editable = (props.round?.status ?? "draft") === "draft";
  const byId = new Map(props.games.map((g) => [g.gameId, g]));
  const inOthers = new Set(props.rounds.filter((r) => r.roundId !== props.round?.roundId).flatMap((r) => r.gameIds));
  // 入れられるのは、下書きで、ほかのラウンドに入っていないゲーム（作った順）
  const addable = props.games.filter(
    (g) => g.status === "draft" && !inOthers.has(g.gameId) && !gameIds.includes(g.gameId),
  );

  const move = (index: number, delta: number) =>
    setGameIds((prev) => {
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      next.splice(index + delta, 0, moved!);
      return next;
    });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const body = { name, gameIds };
      const res = props.round
        ? await api<RoundResponse>("PUT", `/admin/rounds/${props.round.roundId}`, body)
        : await api<RoundResponse>("POST", "/admin/rounds", body);
      await props.onSaved(res.round);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  const title = props.round ? t("ラウンドの編集", "Edit round") : t("ラウンドを作る", "New round");
  return (
    <Modal className="dialog round-dialog" label={title} onClose={props.onClose} closable={!saving}>
      <form className="card" onSubmit={onSubmit}>
        <h2>{title}</h2>
        <label className="field">
          <span>{t("名前", "Name")}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={ROUND_NAME_MAX_LENGTH}
            placeholder={t("例: 第 1 部 クイズ", "e.g. Part 1 quiz")}
            required
          />
        </label>
        <h3 className="small">
          {t(`入れるゲーム（出す順。${ROUND_GAMES_MAX} 問まで）`, `Games (in order, up to ${ROUND_GAMES_MAX})`)}
        </h3>
        {!editable && (
          <p className="muted small">
            {t(
              "開始中・終了済みのラウンドは、ゲームを出し入れできません（名前は直せます）。",
              "Games can’t be added or removed while the round is live or ended (the name can be changed).",
            )}
          </p>
        )}
        {gameIds.length === 0 ? (
          <p className="muted small">
            {t("まだ入っていません。下から追加してください。", "None yet. Add from below.")}
          </p>
        ) : (
          <ol className="round-dialog-list">
            {gameIds.map((id, i) => {
              const g = byId.get(id);
              return (
                <li key={id}>
                  <span className="round-dialog-name">
                    {g ? `${FORMAT_ICON[g.format]} ${g.name}` : t("（削除したゲーム）", "(deleted game)")}
                  </span>
                  {editable && (
                    <span className="round-dialog-buttons">
                      <button
                        type="button"
                        onClick={() => move(i, -1)}
                        disabled={i === 0}
                        aria-label={t("上へ", "Move up")}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => move(i, 1)}
                        disabled={i === gameIds.length - 1}
                        aria-label={t("下へ", "Move down")}
                      >
                        ↓
                      </button>
                      <button type="button" onClick={() => setGameIds((prev) => prev.filter((x) => x !== id))}>
                        {t("外す", "Remove")}
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {editable && (
          <>
            <h3 className="small">
              {t(
                "追加できるゲーム（下書きで、ほかのラウンドに入っていないもの）",
                "Games you can add (drafts not in another round)",
              )}
            </h3>
            {addable.length === 0 ? (
              <p className="muted small">{t("ありません。", "None.")}</p>
            ) : (
              <ul className="round-dialog-list">
                {addable.map((g) => (
                  <li key={g.gameId}>
                    <span className="round-dialog-name">
                      {FORMAT_ICON[g.format]} {g.name}
                      <span className="muted small">
                        {t(`（${gameFormatLabel(g.format, lang)}）`, ` (${gameFormatLabel(g.format, lang)})`)}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setGameIds((prev) => [...prev, g.gameId])}
                      disabled={gameIds.length >= ROUND_GAMES_MAX}
                    >
                      {t("追加", "Add")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {error && <p className="error">{error}</p>}
        <div className="buttons">
          <button type="button" onClick={props.onClose} disabled={saving}>
            {t("キャンセル", "Cancel")}
          </button>
          <button type="submit" className="primary" disabled={saving}>
            {t("保存", "Save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
