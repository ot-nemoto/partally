import {
  GAME_CHOICE_TEXT_MAX_LENGTH,
  GAME_CHOICES_MAX,
  GAME_CHOICES_MIN,
  GAME_DESCRIPTION_MAX_LENGTH,
  GAME_FORMAT_LABEL,
  GAME_FORMAT_LABEL_EN,
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
import { tr, useLang, useT } from "../../../i18n";
import { type ImageDraft, ImageField } from "../ImageField";
import { ImageUploads, uploadGameImage } from "../prizeImage";
import { FORMAT_ICON, FORMAT_ORDER, formatText } from "./formats";

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
  if (ranks.some((r) => [r.from, r.to, r.points].some(Number.isNaN))) {
    return tr("空欄の項目がある範囲があります。", "A range has an empty field.");
  }
  if (ranks.some((r) => r.from < 1)) return tr(`1 ${unit}からです。`, "Ranges start at 1.");
  if (ranks.some((r) => r.from > r.to))
    return tr("「から」が「まで」より大きい範囲があります。", "A range’s “from” is larger than its “to”.");
  const sorted = [...ranks].sort((a, b) => a.from - b.from);
  if (sorted.some((r, i) => i > 0 && sorted[i - 1]!.to >= r.from))
    return tr("重なっている範囲があります。", "Some ranges overlap.");
  return undefined;
}

const newRow = (points = 10): RowDraft => ({ key: `new-${++draftKey}`, name: "", points, userIds: [], image: {} });

const SLOT_PLACEHOLDERS: [ja: string, en: string][] = [
  ["例: 優勝", "e.g. Winner"],
  ["例: 準優勝", "e.g. Runner-up"],
  ["例: ベスト 4", "e.g. Semifinalist"],
];

export function GameFormDialog(props: {
  game?: GameDto;
  onClose: () => void;
  onSaved: (game: GameDto) => void;
  onConflict: () => void;
}) {
  const t = useT();
  const lang = useLang();
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
  // 縮小中の画像の数（問題と選択肢で、いくつも同時に縮小することがある）。縮小中は保存させない（選んだ画像が抜けないように）
  const [processing, setProcessing] = useState(0);
  const onProcessing = (busy: boolean) => setProcessing((n) => n + (busy ? 1 : -1));
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
  /** 順位の範囲で点数を決める形式（数値予想・投票・合言葉・抽選） */
  const ranked = hasGameRanks({ format });
  const unit = rankUnit(format);
  const text = formatText(format, lang);
  // 確定した数値予想・投票・合言葉・抽選は、正解の数と点数の範囲を外せない（入ったポイントが消えないように）
  const lockAnswer = ranked && game?.status === "confirmed";
  const rows = quiz ? choices : slots;
  const setRows = quiz ? setChoices : setSlots;
  // 答えと食い違わないよう、クイズの選択肢を増やす・減らすのは、まだ答えが無い下書きの間だけ
  const canChangeRows = !quiz || !game || (game.status === "draft" && game.storedAnswerCount === 0);
  const maxRows = quiz ? GAME_CHOICES_MAX : GAME_SLOTS_MAX;
  // 確定した結果入力は、最後の枠を消せない（入ったポイントが消えないように）
  const lastSlotLocked = format === "result" && game?.status === "confirmed";
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

  /** 保存し直すときに、同じ画像をアップロードし直さない */
  const [uploads] = useState(() => new ImageUploads(uploadGameImage));

  /** 新しく選んだ画像をアップロードし、付ける imageId を返す（そのままなら保存済みの imageId） */
  async function imageIdOf(draft: ImageDraft): Promise<string | undefined> {
    return draft.blob ? uploads.idOf(draft.blob) : draft.imageId;
  }

  async function save() {
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
    return game
      ? await api<GameResponse>("PUT", `/admin/games/${game.gameId}`, body)
      : await api<GameResponse>("POST", "/admin/games", body);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const res = await uploads.save(save);
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
  const title = game ? t("ゲームの編集", "Edit game") : t("ゲームを作る", "New game");
  const label = quiz ? t("選択肢", "Choice") : t("枠", "Slot");
  const formatLabel = lang === "en" ? GAME_FORMAT_LABEL_EN : GAME_FORMAT_LABEL;

  return (
    <Modal className="dialog game-dialog" label={title} onClose={props.onClose} closable={!saving}>
      <form className="card" onSubmit={onSubmit}>
        <h2>{title}</h2>
        {game ? (
          <p className="small">
            {t("形式: ", "Format: ")}
            <span className="game-format">{formatLabel[format]}</span>
          </p>
        ) : (
          <fieldset className="game-format-choice">
            <legend>{t("形式", "Format")}</legend>
            <div className="game-format-panels">
              {FORMAT_ORDER.map((f) => (
                <label key={f} className={format === f ? "game-format-panel selected" : "game-format-panel"}>
                  <input type="radio" name="format" checked={format === f} onChange={() => setFormat(f)} />
                  <span className="game-format-icon" aria-hidden="true">
                    {FORMAT_ICON[f]}
                  </span>
                  <strong>{formatLabel[f]}</strong>
                  <span className="muted small">{formatText(f, lang).summary}</span>
                </label>
              ))}
            </div>
            <p className="small game-format-about">{text.about}</p>
          </fieldset>
        )}
        <label className="field">
          <span>{t("名前", "Name")}</span>
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
          <span className="muted small">
            {t("参加者のゲームの画面に出ます。", "Shown on the participants’ game screen.")}
          </span>
        </label>
        <ImageField
          label={text.imageLabel}
          image={image}
          onChange={setImage}
          onPicked={track}
          onProcessing={onProcessing}
          disabled={saving}
        />
        {ranked && (
          <>
            {numberGame && (
              <NumberField
                label={
                  lockAnswer
                    ? t("正解の数", "Correct number")
                    : t("正解の数（任意・確定までに入れる）", "Correct number (optional; enter it before finalizing)")
                }
                value={correctNumber}
                min={GAME_NUMBER_MIN}
                max={GAME_NUMBER_MAX}
                onChange={setCorrectNumber}
                optional={!lockAnswer}
              />
            )}
            {voteGame && (
              <NumberField
                label={t("投票した人に入る点数（0 なら入らない）", "Points for each voter (0 for none)")}
                value={voterPoints}
                max={POINTS_MAX}
                onChange={setVoterPoints}
              />
            )}
            {keywordGame && (
              <label className="field">
                <span>{t("合言葉", "Keyword")}</span>
                <input
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  maxLength={GAME_KEYWORD_MAX_LENGTH}
                  placeholder={t("例: パーティー", "e.g. party")}
                  autoComplete="off"
                  required
                />
                <span className="muted small">
                  {t(
                    "参加者には見せません。確定した後に直すと、今の合言葉に合う答えだけで数え直します。",
                    "Not shown to participants. If you change it after finalizing, only answers that match the new keyword are counted.",
                  )}
                </span>
              </label>
            )}
            <fieldset className="game-form-slots">
              <legend>
                {keywordGame
                  ? t("正解した順と点数", "Order of correct answers and points")
                  : t("順位と点数", "Ranks and points")}
              </legend>
              {ranks.map((r, i) => (
                <div key={r.key} className="game-form-slot game-form-rank">
                  <span className="game-form-rank-title small">{t(`範囲 ${i + 1}`, `Range ${i + 1}`)}</span>
                  <NumberField
                    label={t(`何${unit}から`, "From")}
                    value={r.from}
                    min={1}
                    max={GAME_RANK_MAX}
                    onChange={(from) => setRanks((prev) => prev.map((x) => (x.key === r.key ? { ...x, from } : x)))}
                  />
                  <NumberField
                    label={t(`何${unit}まで`, "To")}
                    value={r.to}
                    min={1}
                    max={GAME_RANK_MAX}
                    onChange={(to) => setRanks((prev) => prev.map((x) => (x.key === r.key ? { ...x, to } : x)))}
                  />
                  <NumberField
                    label={t("点数", "Points")}
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
                      aria-label={t(`範囲 ${i + 1} を削除`, `Delete range ${i + 1}`)}
                    >
                      {t("削除", "Delete")}
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setRanks((prev) => [...prev, nextRank(prev)])}
                disabled={ranks.length >= GAME_RANKS_MAX}
              >
                {t("範囲を追加", "Add range")}
              </button>
            </fieldset>
          </>
        )}
        {!ranked && (
          <fieldset className="game-form-slots">
            <legend>{t(`${label}と点数`, `${label}s and points`)}</legend>
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
                    placeholder={
                      quiz ? undefined : t(...(SLOT_PLACEHOLDERS[i] ?? ["例: 参加賞", "e.g. Participation prize"]))
                    }
                    required
                  />
                </label>
                <NumberField
                  label={t("点数", "Points")}
                  value={r.points}
                  max={POINTS_MAX}
                  onChange={(points) => update(r.key, { points })}
                />
                <div className="game-form-slot-actions">
                  <button
                    type="button"
                    onClick={() => move(i, i - 1)}
                    disabled={i === 0}
                    aria-label={t(`${label} ${i + 1} を上へ`, `Move ${label} ${i + 1} up`)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(i, i + 1)}
                    disabled={i === rows.length - 1}
                    aria-label={t(`${label} ${i + 1} を下へ`, `Move ${label} ${i + 1} down`)}
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
                          ? t(
                              "確定済みなので、最後の枠は消せません（先に確定を取り消してください）",
                              "It’s finalized, so the last slot can’t be deleted (undo finalizing first)",
                            )
                          : undefined
                      }
                      aria-label={t(`${label} ${i + 1} を削除`, `Delete ${label} ${i + 1}`)}
                    >
                      {t("削除", "Delete")}
                    </button>
                  )}
                </div>
                {r.userIds.length > 0 && (
                  <p className="muted small game-form-slot-note">
                    {t(`選んだ人: ${r.userIds.length} 人`, `Chosen: ${r.userIds.length}`)}
                  </p>
                )}
                {quiz && (
                  <div className="game-form-slot-note">
                    <ImageField
                      label={t(`${label} ${i + 1} の画像（任意）`, `${label} ${i + 1} image (optional)`)}
                      image={r.image}
                      onChange={(image) => update(r.key, { image })}
                      onPicked={track}
                      onProcessing={onProcessing}
                      disabled={saving}
                      variant="choice"
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
                {t(`${label}を追加`, `Add ${label.toLowerCase()}`)}
              </button>
            ) : (
              <p className="muted small">
                {t(
                  "答えがある・開催した後は、選択肢の追加・削除はできません。文言と点数は直せます（点数を直すと、確定した分も数え直します）。",
                  "Once it has answers or has been started, choices can’t be added or deleted. You can still edit their text and points (changing points recounts finalized results too).",
                )}
              </p>
            )}
          </fieldset>
        )}
        <p className="muted small">
          {text.note}
          {lastSlotLocked &&
            t(
              "確定済みなので、枠を全部は消せません（消すなら先に確定を取り消してください）。",
              " It’s finalized, so you can’t delete every slot (undo finalizing first).",
            )}
          {game?.status === "confirmed" &&
            t(
              "確定済みなので、保存するとすぐにポイントが変わります。",
              " It’s finalized, so points change as soon as you save.",
            )}
        </p>
        {error && <p className="error">{error}</p>}
        {incomplete && (
          <p className="error">
            {voteGame
              ? t("投票した人の点数が空欄です。", "The points for voters are empty.")
              : t(`点数が空欄の${label}があります。`, `A ${label.toLowerCase()} has no points.`)}
          </p>
        )}
        {rankError && <p className="error">{rankError}</p>}
        <div className="buttons">
          <button type="button" onClick={props.onClose} disabled={saving}>
            {t("キャンセル", "Cancel")}
          </button>
          <button
            type="submit"
            className="primary"
            disabled={saving || processing > 0 || incomplete || rankError !== undefined}
          >
            {t("保存", "Save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
