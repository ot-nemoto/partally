import {
  formatRankRange,
  GAME_FORMAT_LABEL,
  type GameDto,
  type GameResponse,
  type GameStatus,
  type GamesResponse,
  gameConfirmProblem,
  hasGameAnswers,
  hasGameRanks,
  rankUnit,
  type TokensResponse,
  type UsersResponse,
} from "@partally/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../api";
import { PageTitle } from "../../components/PageTitle";
import { StatusFilter, useShownStatuses } from "../../components/StatusFilter";
import { formatRecentTime } from "../../format";
import { useOnReload } from "../../hooks/useReload";
import { FORMAT_ICON } from "./games/formats";
import { GameAnswersDialog } from "./games/GameAnswersDialog";
import { GameFormDialog } from "./games/GameFormDialog";
import { GamePreviewDialog } from "./games/GamePreviewDialog";
import { type Member, MemberPickerDialog } from "./games/MemberPickerDialog";

const STATUS_LABEL: Record<GameStatus, string> = { draft: "下書き", open: "開催中", confirmed: "確定" };

/** 表示・非表示を切り替えるボタンの並び */
const STATUSES: GameStatus[] = ["open", "draft", "confirmed"];

/** 保存した直後の一覧の取得が古い内容を返しうる間（一覧は少し遅れて反映される） */
const FRESH_MS = 10_000;

/**
 * ゲーム。形式はクイズ・数値予想・投票・合言葉・抽選・結果入力（アイコンと説明は games/formats.ts）。
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
  const [previewing, setPreviewing] = useState<GameDto>();
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
    if (!confirm(`「${g.name}」を確定します。${confirmNote(g)}よろしいですか？`)) return;
    return post(g, "confirm");
  };
  const stopGame = (g: GameDto) => {
    if (
      !confirm(
        `「${g.name}」の開催をやめて下書きに戻します。${hasGameAnswers(g) ? "答えは残ります。" : ""}よろしいですか？`,
      )
    )
      return;
    return post(g, "stop");
  };
  const unconfirmGame = (g: GameDto) => {
    const redraw =
      g.format === "lottery"
        ? "\n抽選の結果も消え、もう一度確定すると引き直しになります（発表した後は取り消さないでください）。"
        : "";
    if (
      !confirm(`「${g.name}」の確定を取り消して下書きに戻します。入ったポイントも消えます。${redraw}\nよろしいですか？`)
    )
      return;
    return post(g, "unconfirm");
  };
  const remove = (g: GameDto) => {
    const note =
      g.status === "confirmed" ? "\n入ったポイントも消えます。" : g.storedAnswerCount > 0 ? "\n答えも消えます。" : "";
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
        形式は「クイズ」「数値予想」「投票」「合言葉」「抽選」「結果入力」から選べます（それぞれの説明は「ゲームを作る」に出ます）。
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
            <span className="game-format small">
              <span aria-hidden="true">{FORMAT_ICON[g.format]} </span>
              {GAME_FORMAT_LABEL[g.format]}
            </span>
            <span className={`status status-${g.status}`}>{STATUS_LABEL[g.status]}</span>
            {g.status === "open" && hasGameAnswers(g) && (
              <span className="muted small">
                {g.format === "keyword" ? "正解" : g.format === "lottery" ? "参加" : "回答"} {g.answerCount} 人
              </span>
            )}
            {g.confirmedAt && <span className="muted small">{formatRecentTime(g.confirmedAt)} に確定</span>}
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
                  <span className="muted small">{ch.points} 点</span>
                  <span className="num">{ch.answerCount} 人</span>
                </li>
              ))}
            </ul>
          ) : hasGameRanks(g) ? (
            <>
              {g.format === "number" && (
                <p className="small game-number-correct">
                  正解の数:{" "}
                  {g.correctNumber === undefined ? (
                    <span className="muted">未設定（「編集」で入れると確定できます）</span>
                  ) : (
                    <strong>{g.correctNumber}</strong>
                  )}
                </p>
              )}
              {g.format === "vote" && (
                <p className="small game-number-correct">
                  投票した人に: <strong>{g.voterPoints} 点</strong>
                </p>
              )}
              {g.format === "keyword" && (
                <p className="small game-number-correct">
                  合言葉: <strong>{g.keyword}</strong>
                </p>
              )}
              {g.ranks.length === 0 ? (
                <p className="muted small">まだ点数の範囲がありません。「編集」で追加してください。</p>
              ) : (
                <ul className="quiz-admin-choices">
                  {g.ranks.map((r) => (
                    <li key={r.from}>
                      <span>{formatRankRange(r, rankUnit(g.format))}</span>
                      <span className="muted small">{r.points} 点</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
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
                disabled={busy || gameConfirmProblem(g) !== undefined}
                title={gameConfirmProblem(g)}
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
            <button type="button" onClick={() => setPreviewing(g)}>
              プレビュー
            </button>
            {hasGameAnswers(g) && g.storedAnswerCount > 0 && (
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
      return `確定すると答えの受付が終わり、選んだ答えの点数（${g.answerCount} 人）がポイントに入ります。`;
    case "number":
      return `確定すると答えの受付が終わり、正解 ${g.correctNumber} に近い順の順位で点数（${g.answerCount} 人）がポイントに入ります。`;
    case "vote":
      return `確定すると投票の受付が終わり、得票の順位で選ばれた人（投票 ${g.answerCount} 人）にポイントが入ります。`;
    case "keyword":
      return `確定すると受付が終わり、正解した順で点数（正解 ${g.answerCount} 人）がポイントに入ります。`;
    case "lottery":
      return `確定すると受付が終わり、参加した ${g.answerCount} 人から抽選して、当たった人にポイントが入ります。`;
    default:
      return g.slots.some((s) => s.userIds.length > 0)
        ? "確定すると、選んだ人にポイントが入ります。"
        : "まだ誰も選んでいません。";
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
