import {
  GAME_NAME_MAX_LENGTH,
  GAME_SLOT_NAME_MAX_LENGTH,
  GAME_SLOTS_MAX,
  type GameDto,
  type GameResponse,
  type GameStatus,
  type GamesResponse,
  POINTS_MAX,
  type TokensResponse,
  type UserDto,
  type UsersResponse,
} from "@partally/shared";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../../api";
import { Modal } from "../../components/Modal";
import { NumberField } from "../../components/NumberField";
import { PageTitle } from "../../components/PageTitle";
import { useOnReload } from "../../hooks/useReload";

const STATUS_LABEL: Record<GameStatus, string> = { draft: "下書き", confirmed: "確定" };

/** 人を選ぶ画面に出す参加者（QR の通し番号つき） */
interface Member {
  user: UserDto;
  /** QR の通し番号。紐づけを解除した人には無い */
  label?: string;
}

/**
 * ゲーム（じゃんけん大会など）の結果で、枠（優勝・準優勝など）ごとに選んだ人へポイントを付ける。
 * 下書きの間はポイントに入らず、確定するとその時刻で入る
 */
export function AdminGames() {
  const [games, setGames] = useState<GameDto[]>();
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<GameDto | "new">();
  const [picking, setPicking] = useState<{ game: GameDto; slotId: string }>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [g, u, t] = await Promise.all([
        api<GamesResponse>("GET", "/admin/games"),
        api<UsersResponse>("GET", "/admin/users"),
        api<TokensResponse>("GET", "/admin/tokens"),
      ]);
      const labels = new Map(t.tokens.flatMap((tok) => (tok.userId ? [[tok.userId, tok.label] as const] : [])));
      setGames(g.games);
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

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      await load();
    } catch (e) {
      alert(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const confirmGame = (g: GameDto) => {
    const count = g.slots.reduce((n, s) => n + s.userIds.length, 0);
    if (count === 0 && !confirm("まだ誰も選んでいません。このまま確定しますか？")) return;
    return run(() => api<GameResponse>("POST", `/admin/games/${g.gameId}/confirm`));
  };
  const unconfirmGame = (g: GameDto) => {
    if (!confirm(`「${g.name}」の確定を取り消して下書きに戻します。入ったポイントも消えます。よろしいですか？`)) return;
    return run(() => api<GameResponse>("POST", `/admin/games/${g.gameId}/unconfirm`));
  };
  const remove = (g: GameDto) => {
    const note = g.status === "confirmed" ? "\n入ったポイントも消えます。" : "";
    if (!confirm(`「${g.name}」を削除します。${note}\nよろしいですか？`)) return;
    return run(() => api("DELETE", `/admin/games/${g.gameId}`));
  };

  // 新しいゲームを上にする
  const sorted = [...(games ?? [])].reverse();

  return (
    <section className="admin-games">
      <PageTitle en="Game" ja="ゲーム">
        <button type="button" className="primary" onClick={() => setEditing("new")}>
          ゲームを作る
        </button>
      </PageTitle>
      <p className="muted small">
        じゃんけん大会のような催しの結果で、枠（優勝・準優勝など）ごとに選んだ人へポイントを付けます。
        「確定」を押すとポイントが入ります（下書きの間は入りません）。確定した後も直せ、取り消すこともできます。
      </p>
      {error && <p className="error">{error}</p>}
      {games?.length === 0 && <p className="muted">まだゲームがありません。</p>}
      {sorted.map((g) => (
        <article key={g.gameId} className={`card game-card game-${g.status}`}>
          <header className="quiz-card-header">
            <h2 className="game-name">{g.name}</h2>
            <span className={`status status-${g.status}`}>{STATUS_LABEL[g.status]}</span>
            {g.confirmedAt && <span className="muted small">{formatTime(g.confirmedAt)} に確定</span>}
          </header>
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
                    onClick={() => setPicking({ game: g, slotId: s.slotId })}
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
          <div className="actions">
            {g.status === "draft" ? (
              <button type="button" className="primary" onClick={() => confirmGame(g)} disabled={busy}>
                確定
              </button>
            ) : (
              <button type="button" onClick={() => unconfirmGame(g)} disabled={busy}>
                確定を取り消す
              </button>
            )}
            <button type="button" onClick={() => setEditing(g)} disabled={busy}>
              編集
            </button>
            <button type="button" className="danger" onClick={() => remove(g)} disabled={busy}>
              削除
            </button>
          </div>
        </article>
      ))}
      {editing && (
        <GameFormDialog
          game={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            void load();
          }}
        />
      )}
      {picking && (
        <MemberPickerDialog
          game={picking.game}
          slotId={picking.slotId}
          members={members}
          onClose={() => setPicking(undefined)}
          onSaved={() => {
            setPicking(undefined);
            void load();
          }}
        />
      )}
    </section>
  );
}

/** 今日なら時刻だけ、別の日（リハーサルなど）なら日付も付ける */
function formatTime(iso: string) {
  const d = new Date(iso);
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date().toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

interface SlotDraft {
  /** 既存の枠を直すときだけ付く */
  slotId?: string;
  /** 一覧の key 用（新しい枠には slotId が無いため） */
  key: string;
  name: string;
  points: number;
  userIds: string[];
}

let draftKey = 0;
const newSlot = (name = "", points = 10): SlotDraft => ({ key: `new-${++draftKey}`, name, points, userIds: [] });

function GameFormDialog(props: { game?: GameDto; onClose: () => void; onSaved: () => void }) {
  const { game } = props;
  const [name, setName] = useState(game?.name ?? "");
  const [slots, setSlots] = useState<SlotDraft[]>(
    game?.slots.map((s) => ({ ...s, key: s.slotId })) ?? [newSlot("", 30), newSlot("", 20), newSlot("", 10)],
  );
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  function update(key: string, changes: Partial<SlotDraft>) {
    setSlots((prev) => prev.map((s) => (s.key === key ? { ...s, ...changes } : s)));
  }

  function move(from: number, to: number) {
    setSlots((prev) => {
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
    const body = { name, slots: slots.map(({ slotId, name, points, userIds }) => ({ slotId, name, points, userIds })) };
    try {
      if (game) await api<GameResponse>("PUT", `/admin/games/${game.gameId}`, body);
      else await api<GameResponse>("POST", "/admin/games", body);
      props.onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const incomplete = slots.some((s) => Number.isNaN(s.points));
  const title = game ? "ゲームの編集" : "ゲームを作る";

  return (
    <Modal className="dialog game-dialog" label={title} onClose={props.onClose} closable={!saving}>
      <form className="card" onSubmit={onSubmit}>
        <h2>{title}</h2>
        <label className="field">
          <span>ゲームの名前</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={GAME_NAME_MAX_LENGTH}
            placeholder="例: じゃんけん大会"
            required
            data-autofocus
          />
        </label>
        <fieldset className="game-form-slots">
          <legend>枠と点数</legend>
          {slots.map((s, i) => (
            <div key={s.key} className="game-form-slot">
              <label className="field">
                <span>枠 {i + 1}</span>
                <input
                  value={s.name}
                  onChange={(e) => update(s.key, { name: e.target.value })}
                  maxLength={GAME_SLOT_NAME_MAX_LENGTH}
                  placeholder={["例: 優勝", "例: 準優勝", "例: ベスト 4"][i] ?? "例: 参加賞"}
                  required
                />
              </label>
              <NumberField
                label="点数"
                value={s.points}
                max={POINTS_MAX}
                onChange={(points) => update(s.key, { points })}
              />
              <div className="game-form-slot-actions">
                <button
                  type="button"
                  onClick={() => move(i, i - 1)}
                  disabled={i === 0}
                  aria-label={`枠 ${i + 1} を上へ`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(i, i + 1)}
                  disabled={i === slots.length - 1}
                  aria-label={`枠 ${i + 1} を下へ`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="link"
                  onClick={() => setSlots((prev) => prev.filter((x) => x.key !== s.key))}
                  disabled={slots.length <= 1}
                  aria-label={`枠 ${i + 1} を削除`}
                >
                  削除
                </button>
              </div>
              {s.userIds.length > 0 && (
                <p className="muted small game-form-slot-note">選んだ人: {s.userIds.length} 人</p>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() => setSlots((prev) => [...prev, newSlot()])}
            disabled={slots.length >= GAME_SLOTS_MAX}
          >
            枠を追加
          </button>
        </fieldset>
        <p className="muted small">
          人は、保存した後に枠ごとの「人を選ぶ」で選びます。枠を削除すると、その枠で選んだ人も外れます。
          {game?.status === "confirmed" && "確定済みなので、保存するとすぐにポイントが変わります。"}
        </p>
        {error && <p className="error">{error}</p>}
        {incomplete && <p className="error">点数が空欄の枠があります。</p>}
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

/**
 * 枠に入る人を選ぶ。名前・二つ名・通し番号で絞り込み、チェックで複数選ぶ。
 * ほかの枠に入っている人を選ぶと、その枠から移す（1 人は 1 つの枠だけ）
 */
function MemberPickerDialog(props: {
  game: GameDto;
  slotId: string;
  members: Member[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { game, slotId } = props;
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
      await api<GameResponse>("PUT", `/admin/games/${game.gameId}`, { name: game.name, slots });
      props.onSaved();
    } catch (err) {
      setError(errorMessage(err));
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
