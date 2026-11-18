import type { GameDto, GameResponse, UserDto } from "@partally/shared";
import { useMemo, useState } from "react";
import { ApiError, api, errorMessage } from "../../../api";
import { Modal } from "../../../components/Modal";
import { people, pts, useT } from "../../../i18n";

/** 人を選ぶ画面に出す参加者（QR の通し番号つき） */
export interface Member {
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
 * 枠に入る人を選ぶ。名前・二つ名・通し番号で絞り込み、チェックで複数選ぶ。
 * ほかの枠に入っている人を選ぶと、その枠から移す（1 人は 1 つの枠だけ）
 */
export function MemberPickerDialog(props: {
  game: GameDto;
  slotId: string;
  members: Member[];
  onClose: () => void;
  onSaved: (game: GameDto) => void;
  /** ほかで直されていて保存できなかったとき（一覧を読み直す） */
  onConflict: () => void;
}) {
  const t = useT();
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

  const label = t(`${game.name}・${slot.name}の人を選ぶ`, `Choose people for ${game.name} · ${slot.name}`);

  return (
    <Modal className="dialog game-dialog" label={label} onClose={props.onClose} closable={!saving}>
      <div className="card member-picker">
        <h2>
          {slot.name}
          <span className="muted small">
            {" "}
            {t(`${game.name}・${slot.points} 点`, `${game.name} · ${pts(slot.points)}`)}
          </span>
        </h2>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("名前・二つ名・通し番号で絞り込み", "Filter by name, title or number")}
          aria-label={t("絞り込み", "Filter")}
          data-autofocus
        />
        <div className="member-picker-bar">
          <span className="small member-picker-count">
            {t(`${selected.size} 人を選択中`, `${selected.size} selected`)}
          </span>
          <button
            type="button"
            onClick={() => setSelected((prev) => new Set([...prev, ...shown.map((m) => m.user.userId)]))}
            disabled={shown.length === 0}
          >
            {q ? t("表示中の人を全員選ぶ", "Select everyone shown") : t("全員を選ぶ", "Select everyone")}
          </button>
          <button type="button" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
            {t("選択を外す", "Clear selection")}
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
                {user.status === "unbound" && (
                  <span className="member-other muted small">{t("解除済み", "Unlinked")}</span>
                )}
              </label>
            </li>
          ))}
          {shown.length === 0 && <li className="muted small">{t("該当する人がいません。", "No one matches.")}</li>}
        </ul>
        {moving > 0 && (
          <p className="muted small">
            {t(
              `ほかの枠に入っている ${moving} 人は、この枠に移ります。`,
              `${people(moving)} in other slots will move to this slot.`,
            )}
          </p>
        )}
        {game.status === "confirmed" && (
          <p className="muted small">
            {t(
              "締め切り済みなので、保存するとすぐにポイントが変わります。",
              "It’s closed, so points change as soon as you save.",
            )}
          </p>
        )}
        {error && <p className="error">{error}</p>}
        <div className="buttons">
          <button type="button" onClick={props.onClose} disabled={saving}>
            {t("キャンセル", "Cancel")}
          </button>
          <button type="button" className="primary" onClick={save} disabled={saving}>
            {saving ? t("保存中…", "Saving…") : t("保存", "Save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
