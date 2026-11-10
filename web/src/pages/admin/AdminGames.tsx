import {
  type CurrentGameDto,
  formatRankRange,
  GAME_CHOICE_IMAGE_MAX_EDGE,
  GAME_CHOICE_TEXT_MAX_LENGTH,
  GAME_CHOICES_MAX,
  GAME_CHOICES_MIN,
  GAME_DESCRIPTION_MAX_LENGTH,
  GAME_FORMAT_LABEL,
  GAME_FORMATS,
  GAME_KEYWORD_MAX_LENGTH,
  GAME_NAME_MAX_LENGTH,
  GAME_NUMBER_MAX,
  GAME_NUMBER_MIN,
  GAME_RANK_MAX,
  GAME_RANKS_MAX,
  GAME_SLOT_NAME_MAX_LENGTH,
  GAME_SLOTS_MAX,
  type GameAnswerResponse,
  type GameAnswersResponse,
  type GameDto,
  type GameFormat,
  type GameResponse,
  type GameStatus,
  type GamesResponse,
  gameConfirmProblem,
  hasGameAnswers,
  hasGameRanks,
  normalizeKeyword,
  POINTS_MAX,
  PRIZE_IMAGE_MAX_EDGE,
  rankNumberAnswers,
  rankUnit,
  type TokensResponse,
  tallyVotes,
  type UserDto,
  type UsersResponse,
} from "@partally/shared";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, errorMessage } from "../../api";
import { type GameAnswerBody, GameView, gameBannerText } from "../../components/GameView";
import { Modal } from "../../components/Modal";
import { NumberField } from "../../components/NumberField";
import { PageTitle } from "../../components/PageTitle";
import { StatusFilter, useShownStatuses } from "../../components/StatusFilter";
import { useOnReload } from "../../hooks/useReload";
import { processImage } from "../../photos/process";
import { uploadGameImage } from "./prizeImage";

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

/** 更新の本文のうち、ゲームの今の内容（名前・説明・枠・選択肢・点数の範囲・正解の数）。一部だけ変えるときに使う */
function gameBody(game: GameDto) {
  return {
    format: game.format,
    name: game.name,
    description: game.description,
    imageId: game.imageId,
    slots: game.slots.map(({ slotId, name, points, userIds }) => ({ slotId, name, points, userIds })),
    choices: game.choices.map(({ choiceId, text, points, imageId }) => ({ choiceId, text, points, imageId })),
    ranks: game.ranks.map(({ from, to, points }) => ({ from, to, points })),
    correctNumber: game.correctNumber,
    voterPoints: game.format === "vote" ? game.voterPoints : undefined,
    keyword: game.keyword,
  };
}

/**
 * ゲーム。形式はクイズ・数値予想・投票・合言葉・結果入力（説明は FORMAT_TEXT）。
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
        形式は「クイズ」「数値予想」「投票」「合言葉」「結果入力」から選べます（それぞれの説明は「ゲームを作る」に出ます）。
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
            {g.confirmedAt && <span className="muted small">{formatTime(g.confirmedAt)} に確定</span>}
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
            {hasGameAnswers(g) && g.answerCount > 0 && (
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
  /** クイズの選択肢の画像 */
  image: ImageDraft;
}

/**
 * 編集中の画像。imageId は保存済みの画像、blob は新しく選んだ画像（縮小済み）。
 * url は表示用（保存済みなら署名付き URL、新しく選んだならその場で作った URL）。何も無ければ画像なし
 */
interface ImageDraft {
  imageId?: string;
  blob?: Blob;
  url?: string;
}

/** 数値予想の点数の範囲の編集中の行（空欄は NaN） */
interface RankDraft {
  key: string;
  from: number;
  to: number;
  points: number;
}

let draftKey = 0;
const newRank = (from: number, to: number, points: number): RankDraft => ({
  key: `rank-${++draftKey}`,
  from,
  to,
  points,
});
/** 次の範囲は、前の範囲のすぐ後から（前の点数より少し低く） */
function nextRank(ranks: RankDraft[]): RankDraft {
  const last = ranks.at(-1);
  const from = last && !Number.isNaN(last.to) ? Math.min(GAME_RANK_MAX, last.to + 1) : 1;
  const points = last && !Number.isNaN(last.points) ? Math.max(0, last.points - 2) : 10;
  return newRank(from, from, points);
}

/** 点数の範囲の誤り（空欄・逆転・重なり）。無ければ undefined */
function rankProblem(ranks: RankDraft[], unit: string): string | undefined {
  if (ranks.some((r) => [r.from, r.to, r.points].some(Number.isNaN))) return "空欄の項目がある範囲があります。";
  if (ranks.some((r) => r.from < 1)) return `1 ${unit}からです。`;
  if (ranks.some((r) => r.from > r.to)) return "「から」が「まで」より大きい範囲があります。";
  const sorted = [...ranks].sort((a, b) => a.from - b.from);
  if (sorted.some((r, i) => i > 0 && sorted[i - 1]!.to >= r.from)) return "重なっている範囲があります。";
  return undefined;
}

const newRow = (points = 10): RowDraft => ({ key: `new-${++draftKey}`, name: "", points, userIds: [], image: {} });

/** 新しく選んだ画像をアップロードし、付ける imageId を返す（そのままなら保存済みの imageId） */
async function imageIdOf(image: ImageDraft): Promise<string | undefined> {
  return image.blob ? uploadGameImage(image.blob) : image.imageId;
}

const SLOT_PLACEHOLDERS = ["例: 優勝", "例: 準優勝", "例: ベスト 4"];

/** 形式を選ぶパネルの並び（参加者が答える形式を先に、結果入力を最後に） */
const FORMAT_ORDER: GameFormat[] = [...GAME_FORMATS].sort((a, b) => Number(a === "result") - Number(b === "result"));

/** 形式のアイコン（形式を選ぶパネルとカードに出す） */
const FORMAT_ICON: Record<GameFormat, string> = {
  quiz: "❓",
  number: "🔢",
  vote: "🗳️",
  keyword: "🔑",
  lottery: "🎲",
  result: "🏆",
};

/** 形式ごとの、作る画面の案内（summary は形式を選ぶパネルの一言） */
const FORMAT_TEXT: Record<
  GameFormat,
  {
    summary: string;
    about: string;
    name: string;
    descriptionLabel: string;
    description: string;
    imageLabel: string;
    note: string;
  }
> = {
  quiz: {
    summary: "選択肢から選ぶ",
    about: "参加者がスマホで選択肢から選び、選んだ答えの点数が入ります",
    name: "例: 第 1 問",
    descriptionLabel: "問題文",
    description: "例: 幹事の出身地は？",
    imageLabel: "問題の画像（任意）",
    note: "正解は 10 点、惜しい答えは 5 点のように、選択肢ごとに点数を決められます。参加者には点数は見せません。",
  },
  number: {
    summary: "数を予想する",
    about: `参加者が数（${GAME_NUMBER_MIN}〜${GAME_NUMBER_MAX}）を予想し、正解に近い順の順位で点数が入ります`,
    name: "例: 瓶の中の飴の数",
    descriptionLabel: "問題文",
    description: "例: 瓶の中に飴は何個入っている？",
    imageLabel: "問題の画像（任意）",
    note: "正解に近い順に順位を付け、順位が入る範囲の点数が入ります（同じだけ離れた人は同じ順位。どの範囲にも入らない順位は 0 点）。順位の範囲は参加者にも見せ、正解の数は見せません。",
  },
  vote: {
    summary: "1 人に投票する",
    about: "参加者が全員の中から 1 人に投票し、票の多い順の順位で選ばれた人に点数が入ります",
    name: "例: 今日の MVP",
    descriptionLabel: "説明（任意）",
    description: "例: 今日いちばん盛り上げた人に投票してください",
    imageLabel: "画像（任意）",
    note: "票の多い順に順位を付け、選ばれた人に順位が入る範囲の点数が入ります（同じ票数は同じ順位。0 票の人とどの範囲にも入らない順位は 0 点）。自分と、紐づけを解除した人には投票できません。誰が誰に投票したかは参加者には見せません。",
  },
  keyword: {
    summary: "見つけた言葉を入れる",
    about: "会場で見つけた合言葉を参加者が入れ、正解した順（先着順）で点数が入ります",
    name: "例: 宝探し",
    descriptionLabel: "説明（任意）",
    description: "例: 会場のどこかに合言葉が隠れています。見つけたら入れてください",
    imageLabel: "画像（任意）",
    note: "正解した順に番号を付け、番号が入る範囲の点数が入ります（どの範囲にも入らない番号は 0 点）。全角・半角、大文字・小文字、カタカナ・ひらがな、空白の違いは同じ言葉として扱います。合言葉は参加者には見せません。",
  },
  lottery: {
    summary: "参加して抽選",
    about: "参加者が「参加する」を押し、確定したときにアプリが無作為に決めた順番で点数が入ります",
    name: "例: ラッキー賞",
    descriptionLabel: "説明（任意）",
    description: "例: 参加ボタンを押した人の中から、抽選で 5 名にポイントをプレゼント",
    imageLabel: "画像（任意）",
    note: "確定したときに、参加した人の順番を無作為に決めて保存し、順番が入る範囲の点数が入ります（どの範囲にも入らない人は 0 点）。確定した後に範囲や点数を直しても、順番は変わりません。確定を取り消してもう一度確定すると、引き直します。",
  },
  result: {
    summary: "幹事が結果を入れる",
    about: "じゃんけん大会などの結果で、枠（優勝など）ごとに人を選んで点数を付けます",
    name: "例: じゃんけん大会",
    descriptionLabel: "説明（任意）",
    description: "例: 負けた人は座ってください。最後まで残った人が優勝です",
    imageLabel: "画像（任意）",
    note: "枠は後から追加することもできます（枠が無いゲームは確定できません）。人は、保存した後に枠ごとの「人を選ぶ」で選びます。枠を削除すると、その枠で選んだ人も外れます。",
  },
};

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
    game?.slots.map((s) => ({
      id: s.slotId,
      key: s.slotId,
      name: s.name,
      points: s.points,
      userIds: s.userIds,
      image: {},
    })) ?? [],
  );
  const [choices, setChoices] = useState<RowDraft[]>(
    game?.choices.map((ch) => ({
      id: ch.choiceId,
      key: ch.choiceId,
      name: ch.text,
      points: ch.points,
      userIds: [],
      image: { imageId: ch.imageId, url: ch.imageUrl },
    })) ?? [newRow(10), newRow(0), newRow(0)],
  );
  // 数値予想は 1 位 10 点・2〜3 位 5 点で始める
  const [ranks, setRanks] = useState<RankDraft[]>(
    game?.ranks.map((r) => newRank(r.from, r.to, r.points)) ?? [newRank(1, 1, 10), newRank(2, 3, 5)],
  );
  const [correctNumber, setCorrectNumber] = useState(game?.correctNumber ?? Number.NaN);
  const [voterPoints, setVoterPoints] = useState(game?.voterPoints ?? 0);
  const [keyword, setKeyword] = useState(game?.keyword ?? "");
  const [image, setImage] = useState<ImageDraft>({ imageId: game?.imageId, url: game?.imageUrl });
  // 新しく選んだ画像の表示用 URL は、閉じるときにまとめて解放する
  const created = useRef<string[]>([]);
  const track = (url: string) => created.current.push(url);
  useEffect(
    () => () => {
      for (const url of created.current) URL.revokeObjectURL(url);
    },
    [],
  );
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const quiz = format === "quiz";
  const numberGame = format === "number";
  const voteGame = format === "vote";
  const keywordGame = format === "keyword";
  /** 順位の範囲で点数を決める形式（数値予想・投票・合言葉） */
  const ranked = hasGameRanks({ format });
  const unit = rankUnit(format);
  const text = FORMAT_TEXT[format];
  // 確定した数値予想・投票・合言葉は、正解の数と点数の範囲を外せない（入ったポイントが消えないように）
  const lockAnswer = ranked && game?.status === "confirmed";
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
    try {
      // 新しく選んだ画像を先にアップロードする（保存したときに、サーバが受け口から移す）
      const body = {
        format,
        name,
        description,
        imageId: await imageIdOf(image),
        slots:
          format !== "result"
            ? []
            : slots.map((s) => ({ slotId: s.id, name: s.name, points: s.points, userIds: s.userIds })),
        choices: quiz
          ? await Promise.all(
              choices.map(async (ch) => ({
                choiceId: ch.id,
                text: ch.name,
                points: ch.points,
                imageId: await imageIdOf(ch.image),
              })),
            )
          : [],
        ranks: ranked ? ranks.map(({ from, to, points }) => ({ from, to, points })) : [],
        correctNumber: numberGame && !Number.isNaN(correctNumber) ? correctNumber : undefined,
        voterPoints: voteGame ? voterPoints : undefined,
        keyword: keywordGame ? keyword : undefined,
        // 開いた後にほかで直されていたら、上書きせずに知らせる
        baseUpdatedAt: game?.updatedAt,
      };
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

  const incomplete = ranked ? voteGame && Number.isNaN(voterPoints) : rows.some((r) => Number.isNaN(r.points));
  const rankError = ranked ? rankProblem(ranks, unit) : undefined;
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
            <div className="game-format-panels">
              {FORMAT_ORDER.map((f) => (
                <label key={f} className={format === f ? "game-format-panel selected" : "game-format-panel"}>
                  <input type="radio" name="format" checked={format === f} onChange={() => setFormat(f)} />
                  <span className="game-format-icon" aria-hidden="true">
                    {FORMAT_ICON[f]}
                  </span>
                  <strong>{GAME_FORMAT_LABEL[f]}</strong>
                  <span className="muted small">{FORMAT_TEXT[f].summary}</span>
                </label>
              ))}
            </div>
            <p className="small game-format-about">{FORMAT_TEXT[format].about}</p>
          </fieldset>
        )}
        <label className="field">
          <span>名前</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={GAME_NAME_MAX_LENGTH}
            placeholder={text.name}
            required
            data-autofocus
          />
        </label>
        <label className="field">
          <span>{text.descriptionLabel}</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={GAME_DESCRIPTION_MAX_LENGTH}
            rows={3}
            placeholder={text.description}
          />
          <span className="muted small">参加者のゲームの画面に出ます。</span>
        </label>
        <ImageField label={text.imageLabel} image={image} onChange={setImage} onPicked={track} disabled={saving} />
        {ranked && (
          <>
            {numberGame && (
              <NumberField
                label={lockAnswer ? "正解の数" : "正解の数（任意・確定までに入れる）"}
                value={correctNumber}
                min={GAME_NUMBER_MIN}
                max={GAME_NUMBER_MAX}
                onChange={setCorrectNumber}
                optional={!lockAnswer}
              />
            )}
            {voteGame && (
              <NumberField
                label="投票した人に入る点数（0 なら入らない）"
                value={voterPoints}
                max={POINTS_MAX}
                onChange={setVoterPoints}
              />
            )}
            {keywordGame && (
              <label className="field">
                <span>合言葉</span>
                <input
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  maxLength={GAME_KEYWORD_MAX_LENGTH}
                  placeholder="例: パーティー"
                  autoComplete="off"
                  required
                />
                <span className="muted small">
                  参加者には見せません。確定した後に直すと、今の合言葉に合う答えだけで数え直します。
                </span>
              </label>
            )}
            <fieldset className="game-form-slots">
              <legend>{keywordGame ? "正解した順と点数" : "順位と点数"}</legend>
              {ranks.map((r, i) => (
                <div key={r.key} className="game-form-slot game-form-rank">
                  <span className="game-form-rank-title small">範囲 {i + 1}</span>
                  <NumberField
                    label={`何${unit}から`}
                    value={r.from}
                    min={1}
                    max={GAME_RANK_MAX}
                    onChange={(from) => setRanks((prev) => prev.map((x) => (x.key === r.key ? { ...x, from } : x)))}
                  />
                  <NumberField
                    label={`何${unit}まで`}
                    value={r.to}
                    min={1}
                    max={GAME_RANK_MAX}
                    onChange={(to) => setRanks((prev) => prev.map((x) => (x.key === r.key ? { ...x, to } : x)))}
                  />
                  <NumberField
                    label="点数"
                    value={r.points}
                    max={POINTS_MAX}
                    onChange={(points) => setRanks((prev) => prev.map((x) => (x.key === r.key ? { ...x, points } : x)))}
                  />
                  <div className="game-form-slot-actions">
                    <button
                      type="button"
                      className="link"
                      onClick={() => setRanks((prev) => prev.filter((x) => x.key !== r.key))}
                      disabled={lockAnswer && ranks.length <= 1}
                      aria-label={`範囲 ${i + 1} を削除`}
                    >
                      削除
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setRanks((prev) => [...prev, nextRank(prev)])}
                disabled={ranks.length >= GAME_RANKS_MAX}
              >
                範囲を追加
              </button>
            </fieldset>
          </>
        )}
        {!ranked && (
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
                {quiz && (
                  <div className="game-form-slot-note">
                    <ImageField
                      label={`${label} ${i + 1} の画像（任意）`}
                      image={r.image}
                      onChange={(image) => update(r.key, { image })}
                      onPicked={track}
                      disabled={saving}
                      small
                    />
                  </div>
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
        )}
        <p className="muted small">
          {text.note}
          {game?.status === "confirmed" && "確定済みなので、保存するとすぐにポイントが変わります。"}
        </p>
        {error && <p className="error">{error}</p>}
        {incomplete && (
          <p className="error">{voteGame ? "投票した人の点数が空欄です。" : `点数が空欄の${label}があります。`}</p>
        )}
        {rankError && <p className="error">{rankError}</p>}
        <div className="buttons">
          <button type="button" onClick={props.onClose} disabled={saving}>
            キャンセル
          </button>
          <button type="submit" className="primary" disabled={saving || incomplete || rankError !== undefined}>
            保存
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** 画像を選ぶ・変える・外す。選んだ画像は端末で縮小・JPEG にしてから持つ（アップロードは保存のとき） */
function ImageField(props: {
  label: string;
  image: ImageDraft;
  onChange: (image: ImageDraft) => void;
  /** 新しく作った表示用 URL（呼び出し側が閉じるときに解放する） */
  onPicked: (url: string) => void;
  disabled?: boolean;
  /** 選択肢の画像（小さく出し、縮小も小さめにする） */
  small?: boolean;
}) {
  const { image } = props;
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string>();
  const fileRef = useRef<HTMLInputElement>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setProcessing(true);
    setError(undefined);
    try {
      const blob = await processImage(file, props.small ? GAME_CHOICE_IMAGE_MAX_EDGE : PRIZE_IMAGE_MAX_EDGE);
      const url = URL.createObjectURL(blob);
      props.onPicked(url);
      props.onChange({ blob, url });
    } catch {
      setError("画像を読み込めませんでした。別の画像を選んでください。");
    } finally {
      setProcessing(false);
    }
  }

  return (
    <div className={`field game-image-field${props.small ? " small" : ""}`}>
      <span>{props.label}</span>
      <div className="game-image-field-body">
        {image.url ? (
          <img className="game-image-preview" src={image.url} alt="選んだ画像" />
        ) : (
          <span className="game-image-preview placeholder" aria-hidden="true">
            🖼
          </span>
        )}
        <div className="game-image-actions">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={processing || props.disabled}
            aria-label={`${props.label}を${image.url ? "変える" : "選ぶ"}`}
          >
            {processing ? "読み込み中…" : image.url ? "画像を変える" : "画像を選ぶ"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*,.heic,.heif"
            hidden
            onChange={(e) => {
              void pick(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {image.url && (
            <button
              type="button"
              className="link"
              onClick={() => props.onChange({})}
              disabled={props.disabled}
              aria-label={`${props.label}を外す`}
            >
              外す
            </button>
          )}
        </div>
      </div>
      {error && <span className="error small">{error}</span>}
    </div>
  );
}

/** クイズ・数値予想・投票で、だれが何を答えたか */
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
        {props.game.imageUrl && <img className="game-image" src={props.game.imageUrl} alt="" />}
        {props.game.description && <p className="quiz-text">{props.game.description}</p>}
        {error && <p className="error">{error}</p>}
        {!data && !error && <p className="muted">読み込み中…</p>}
        {data?.game.format === "number" && <NumberAnswers game={data.game} answers={data.answers} />}
        {data?.game.format === "vote" && <VoteAnswers game={data.game} answers={data.answers} />}
        {data?.game.format === "keyword" && <KeywordAnswers game={data.game} answers={data.answers} />}
        {data?.game.format === "lottery" && <LotteryAnswers game={data.game} answers={data.answers} />}
        {data?.game.choices.map((ch) => {
          const names = data.answers.filter((a) => a.choiceId === ch.choiceId);
          return (
            <section key={ch.choiceId} className="quiz-result">
              <h3 className="game-choice-label">
                {ch.imageUrl && <img className="game-choice-thumb" src={ch.imageUrl} alt="" />}
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

/** 数値予想で、だれが何を答えたか（正解の数があれば、近い順に順位と点数も） */
function NumberAnswers(props: { game: GameDto; answers: GameAnswersResponse["answers"] }) {
  const { game } = props;
  const answers = props.answers.filter((a): a is typeof a & { value: number } => a.value !== undefined);
  if (answers.length === 0) return <p className="muted small">まだ答えがありません。</p>;
  const correct = game.correctNumber;
  if (correct === undefined) {
    const sorted = [...answers].sort((a, b) => a.value - b.value);
    return (
      <>
        <p className="muted small">正解の数を入れると、順位と点数が出ます。</p>
        <table className="game-number-answers">
          <thead>
            <tr>
              <th>答え</th>
              <th>名前</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => (
              <tr key={a.userId}>
                <td className="num">{a.value}</td>
                <td>{a.displayName ?? "（不明なユーザ）"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    );
  }
  const results = rankNumberAnswers(
    answers.map((a) => a.value),
    correct,
    game.ranks,
  );
  const rows = answers.map((a, i) => ({ answer: a, ...results[i]! })).sort((a, b) => a.rank - b.rank);
  return (
    <>
      <p className="small">
        正解: <strong>{correct}</strong>
      </p>
      <table className="game-number-answers">
        <thead>
          <tr>
            <th>順位</th>
            <th>答え</th>
            <th>差</th>
            <th>名前</th>
            <th>点数</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.answer.userId}>
              <td className="num">{r.rank} 位</td>
              <td className="num">{r.answer.value}</td>
              <td className="num">{r.diff}</td>
              <td>{r.answer.displayName ?? "（不明なユーザ）"}</td>
              <td className="num">{r.points} 点</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** 参加者の画面で見せる形（参加者に返す内容と同じく、点数・正解・合言葉は含めない） */
function toPreviewGame(game: GameDto): CurrentGameDto {
  return {
    gameId: game.gameId,
    format: game.format,
    name: game.name,
    description: game.description,
    imageUrl: game.imageUrl,
    slots: game.slots.map(({ name, points }) => ({ name, points })),
    choices: game.choices.map(({ choiceId, text, imageUrl }) => ({ choiceId, text, imageUrl })),
    ranks: game.ranks,
    voterPoints: game.voterPoints,
    myKeywordCorrect: game.format === "keyword" ? false : undefined,
    myEntry: game.format === "lottery" ? false : undefined,
  };
}

/**
 * 参加者の画面のプレビュー。スマホの大きさの枠に、お知らせとゲームの画面を出す（参加者の画面と同じ部品）。
 * 答えはこの画面の中だけで試せて、保存しない。投票の候補は登録済みの参加者から出す
 */
function GamePreviewDialog(props: { game: GameDto; members: UserDto[]; onClose: () => void }) {
  const { game } = props;
  const [current, setCurrent] = useState(() => toPreviewGame(game));
  /** 「答える前に戻す」で入力中の内容も消すよう、画面を作り直す印 */
  const [resetKey, setResetKey] = useState(0);
  const banner = gameBannerText(current);
  const candidates = useMemo(
    () =>
      props.members
        .filter((u) => u.status === "active")
        .map((u) => ({ userId: u.userId, displayName: u.displayName }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName, "ja")),
    [props.members],
  );
  const loadCandidates = useCallback(async () => candidates, [candidates]);
  const noop = useCallback(() => {}, []);

  // 送らずに、参加者の画面が答えた後どう変わるかだけ見せる
  async function onAnswer(body: GameAnswerBody): Promise<GameAnswerResponse> {
    const correct = "text" in body ? normalizeKeyword(body.text) === normalizeKeyword(game.keyword ?? "") : undefined;
    const next: CurrentGameDto =
      "choiceId" in body
        ? { ...current, myChoiceId: body.choiceId }
        : "value" in body
          ? { ...current, myValue: body.value }
          : "targetUserId" in body
            ? { ...current, myTargetUserId: body.targetUserId }
            : "entry" in body
              ? { ...current, myEntry: true }
              : { ...current, myKeywordCorrect: current.myKeywordCorrect || correct };
    setCurrent(next);
    return { game: next, correct };
  }

  return (
    <Modal className="dialog game-preview-dialog" label="プレビュー" onClose={props.onClose}>
      <div className="card">
        <h2>プレビュー</h2>
        <p className="muted small">
          開催したときの参加者のスマホの画面です。答えはここで試せますが、保存はしません。
          {game.status === "draft" && "下書きのうちは、参加者には見えません。"}
        </p>
        <div className="game-preview-phone">
          <div className="participant game-preview-screen">
            <main className="page">
              <div className="quiz-banner" aria-hidden="true">
                <strong>{banner.title}</strong>
                <span className="quiz-banner-sub">{banner.note}</span>
              </div>
              <GameView
                key={resetKey}
                game={current}
                onAnswer={onAnswer}
                loadCandidates={loadCandidates}
                onClosed={noop}
              />
            </main>
          </div>
        </div>
        <div className="buttons">
          <button
            type="button"
            onClick={() => {
              setCurrent(toPreviewGame(game));
              setResetKey((k) => k + 1);
            }}
          >
            答える前に戻す
          </button>
          <button type="button" onClick={props.onClose}>
            閉じる
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** 抽選で、確定する前は参加した人、確定した後は引いた順番と点数 */
function LotteryAnswers(props: { game: GameDto; answers: GameAnswersResponse["answers"] }) {
  const { game } = props;
  const names = new Map(props.answers.map((a) => [a.userId, a.displayName ?? "（不明なユーザ）"]));
  if (!game.drawOrder) {
    return (
      <>
        <p className="small">参加 {props.answers.length} 人（確定したときに抽選します）</p>
        <p className="small">
          {props.answers.map((a) => names.get(a.userId)).join("、") || "まだ参加した人がいません。"}
        </p>
      </>
    );
  }
  const winners = game.drawOrder.flatMap((userId, i) => {
    const range = game.ranks.find((r) => r.from <= i + 1 && i + 1 <= r.to);
    return range ? [{ userId, order: i + 1, range }] : [];
  });
  return (
    <>
      <p className="small">
        参加 {game.drawOrder.length} 人・当選 {winners.length} 人
      </p>
      {winners.length === 0 ? (
        <p className="muted small">当選した人はいません。</p>
      ) : (
        <table className="game-number-answers">
          <thead>
            <tr>
              <th>順番</th>
              <th>名前</th>
              <th>当選</th>
              <th>点数</th>
            </tr>
          </thead>
          <tbody>
            {winners.map((w) => (
              <tr key={w.userId}>
                <td className="num">{w.order}</td>
                <td>{names.get(w.userId) ?? "（不明なユーザ）"}</td>
                <td>{formatRankRange(w.range, "等")}</td>
                <td className="num">{w.range.points} 点</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/** 合言葉で、正解した順に番号・名前・入れた言葉・点数（今の合言葉に合わない答えは数えない） */
function KeywordAnswers(props: { game: GameDto; answers: GameAnswersResponse["answers"] }) {
  const { game } = props;
  const keyword = normalizeKeyword(game.keyword ?? "");
  const correct = props.answers
    .filter((a) => a.text !== undefined && normalizeKeyword(a.text) === keyword)
    .sort((a, b) => a.answeredAt.localeCompare(b.answeredAt) || a.userId.localeCompare(b.userId));
  const stale = props.answers.length - correct.length;
  if (correct.length === 0 && stale === 0) return <p className="muted small">まだ正解した人がいません。</p>;
  return (
    <>
      <p className="small">
        正解 {correct.length} 人{stale > 0 && `（合言葉を直す前に正解した ${stale} 人は数えません）`}
      </p>
      <table className="game-number-answers">
        <thead>
          <tr>
            <th>順</th>
            <th>名前</th>
            <th>入れた言葉</th>
            <th>時刻</th>
            <th>点数</th>
          </tr>
        </thead>
        <tbody>
          {correct.map((a, i) => (
            <tr key={a.userId}>
              <td className="num">{i + 1} 番目</td>
              <td>{a.displayName ?? "（不明なユーザ）"}</td>
              <td>{a.text}</td>
              <td className="num">{formatTime(a.answeredAt)}</td>
              <td className="num">{game.ranks.find((r) => r.from <= i + 1 && i + 1 <= r.to)?.points ?? 0} 点</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** 投票で、票の多い順に順位・票数・点数と、投票した人 */
function VoteAnswers(props: { game: GameDto; answers: GameAnswersResponse["answers"] }) {
  const votes = props.answers.filter((a): a is typeof a & { targetUserId: string } => a.targetUserId !== undefined);
  if (votes.length === 0) return <p className="muted small">まだ投票がありません。</p>;
  const results = tallyVotes(
    votes.map((a) => a.targetUserId),
    props.game.ranks,
  );
  const unknown = "（不明なユーザ）";
  return (
    <>
      <p className="small">
        投票 {votes.length} 人{props.game.voterPoints > 0 && `（投票した人に ${props.game.voterPoints} 点）`}
      </p>
      <table className="game-number-answers">
        <thead>
          <tr>
            <th>順位</th>
            <th>選ばれた人</th>
            <th>票</th>
            <th>点数</th>
            <th>投票した人</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => {
            const voters = votes.filter((a) => a.targetUserId === r.userId);
            return (
              <tr key={r.userId}>
                <td className="num">{r.rank} 位</td>
                <td>{voters[0]?.targetDisplayName ?? unknown}</td>
                <td className="num">{r.votes}</td>
                <td className="num">{r.points} 点</td>
                <td className="game-voters small">{voters.map((a) => a.displayName ?? unknown).join("、")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
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
