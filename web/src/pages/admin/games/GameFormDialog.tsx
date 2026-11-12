import {
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
  type GameDto,
  type GameFormat,
  type GameResponse,
  hasGameRanks,
  POINTS_MAX,
  rankUnit,
} from "@partally/shared";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, api, errorMessage } from "../../../api";
import { Modal } from "../../../components/Modal";
import { NumberField } from "../../../components/NumberField";
import { uploadGameImage } from "../prizeImage";
import { type ImageDraft, ImageField } from "./ImageField";

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
export const FORMAT_ICON: Record<GameFormat, string> = {
  quiz: "❓",
  number: "🔢",
  vote: "🗳️",
  keyword: "🔑",
  lottery: "🎲",
  result: "🏆",
};

/** 形式ごとの、作る画面の案内（summary は形式を選ぶパネルの一言） */
export const FORMAT_TEXT: Record<
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
    note: "正解に近い順に順位を付け、順位が入る範囲の点数が入ります（同じだけ離れた人は同じ順位。どの範囲にも入らない順位は 0 点）。点数と正解の数は参加者には見せません。",
  },
  vote: {
    summary: "1 人に投票する",
    about: "参加者が全員の中から 1 人に投票し、票の多い順の順位で選ばれた人に点数が入ります",
    name: "例: 今日の MVP",
    descriptionLabel: "説明（任意）",
    description: "例: 今日いちばん盛り上げた人に投票してください",
    imageLabel: "画像（任意）",
    note: "票の多い順に順位を付け、選ばれた人に順位が入る範囲の点数が入ります（同じ票数は同じ順位。0 票の人とどの範囲にも入らない順位は 0 点）。自分と、紐づけを解除した人には投票できません。点数と、誰が誰に投票したかは参加者には見せません。",
  },
  keyword: {
    summary: "見つけた言葉を入れる",
    about: "会場で見つけた合言葉を参加者が入れ、正解した順（先着順）で点数が入ります",
    name: "例: 宝探し",
    descriptionLabel: "説明（任意）",
    description: "例: 会場のどこかに合言葉が隠れています。見つけたら入れてください",
    imageLabel: "画像（任意）",
    note: "正解した順に番号を付け、番号が入る範囲の点数が入ります（どの範囲にも入らない番号は 0 点）。全角・半角、大文字・小文字、カタカナ・ひらがな、空白の違いは同じ言葉として扱います。点数と合言葉は参加者には見せません。",
  },
  lottery: {
    summary: "参加して抽選",
    about: "参加者が「参加する」を押し、確定したときにアプリが無作為に決めた順番で点数が入ります",
    name: "例: ラッキー賞",
    descriptionLabel: "説明（任意）",
    description: "例: 参加ボタンを押した人の中から、抽選で 5 名にポイントをプレゼント",
    imageLabel: "画像（任意）",
    note: "確定したときに、参加した人の順番を無作為に決めて保存し、順番が入る範囲の点数が入ります（どの範囲にも入らない人は 0 点）。確定した後に範囲や点数を直しても、順番は変わりません。確定を取り消してもう一度確定すると、引き直します。点数は参加者には見せません。",
  },
  result: {
    summary: "幹事が結果を入れる",
    about: "じゃんけん大会などの結果で、枠（優勝など）ごとに人を選んで点数を付けます",
    name: "例: じゃんけん大会",
    descriptionLabel: "説明（任意）",
    description: "例: 負けた人は座ってください。最後まで残った人が優勝です",
    imageLabel: "画像（任意）",
    note: "枠は後から追加することもできます（枠が無いゲームは確定できません）。人は、保存した後に枠ごとの「人を選ぶ」で選びます。枠を削除すると、その枠で選んだ人も外れます。枠の点数は参加者には見せません。",
  },
};

export function GameFormDialog(props: {
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
  const canChangeRows = !quiz || !game || (game.status === "draft" && game.storedAnswerCount === 0);
  const maxRows = quiz ? GAME_CHOICES_MAX : GAME_SLOTS_MAX;
  // 確定した結果入力は、最後の枠を消せない（入ったポイントが消えないように）
  const lastSlotLocked = !quiz && game?.status === "confirmed";
  const minRows = quiz ? GAME_CHOICES_MIN : lastSlotLocked ? 1 : 0;

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
                      title={
                        lastSlotLocked && rows.length <= minRows
                          ? "確定済みなので、最後の枠は消せません（先に確定を取り消してください）"
                          : undefined
                      }
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
          {lastSlotLocked && "確定済みなので、枠を全部は消せません（消すなら先に確定を取り消してください）。"}
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
