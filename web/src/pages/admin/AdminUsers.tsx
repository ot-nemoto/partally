import type { PinStatus, UserDto, UserResponse, UsersResponse } from "@partally/shared";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../api";
import { Modal } from "../../components/Modal";
import { PageTitle } from "../../components/PageTitle";
import { useOnReload } from "../../hooks/useReload";
import { useT } from "../../i18n";

const PIN_LABEL: Record<PinStatus, [ja: string, en: string]> = {
  none: ["未設定", "Not set"],
  set: ["設定済み", "Set"],
  locked: ["ロック中", "Locked"],
};

export function AdminUsers() {
  const t = useT();
  const [users, setUsers] = useState<UserDto[]>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<UserDto>();

  const load = useCallback(() => {
    api<UsersResponse>("GET", "/admin/users")
      .then((res) => {
        setUsers(res.users);
        setError(undefined);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  useEffect(load, [load]);
  useOnReload(load);

  function replace(user: UserDto) {
    setUsers((prev) => prev?.map((u) => (u.userId === user.userId ? user : u)));
  }

  async function unbind(user: UserDto) {
    if (
      !confirm(
        t(
          `${user.displayName} と QR コードの紐づけを解除します。\n本人は再ログインできなくなり、その QR は新規登録用に戻ります。よろしいですか？`,
          `Unlink ${user.displayName} from the QR code?\nThey won’t be able to log in again, and the QR code goes back to unused.`,
        ),
      )
    ) {
      return;
    }
    try {
      const res = await api<UserResponse>("POST", `/admin/users/${user.userId}/unbind`);
      replace(res.user);
    } catch (e) {
      alert(errorMessage(e));
    }
  }

  /** 暗証番号のロックを解除する（間違えた回数を 0 に戻す） */
  async function unlockPin(user: UserDto) {
    if (
      !confirm(
        t(
          `${user.displayName} の暗証番号のロックを解除します。よろしいですか？`,
          `Unlock the PIN of ${user.displayName}?`,
        ),
      )
    )
      return;
    try {
      replace((await api<UserResponse>("POST", `/admin/users/${user.userId}/pin/unlock`)).user);
    } catch (e) {
      alert(errorMessage(e));
    }
  }

  /** 暗証番号を消す（忘れた人。次にほかの端末で QR コードを読み込んだときに決め直す） */
  async function clearPin(user: UserDto) {
    if (
      !confirm(
        t(
          `${user.displayName} の暗証番号を消します。\n次にログインしていない端末で QR コードを読み込んだ人が、新しい暗証番号を決められます。本人がその場で読み込むときに消してください。よろしいですか？`,
          `Clear the PIN of ${user.displayName}?\nThe next person to scan the QR code on a device that isn’t logged in can set a new PIN, so do this only while they scan it in front of you.`,
        ),
      )
    ) {
      return;
    }
    try {
      replace((await api<UserResponse>("DELETE", `/admin/users/${user.userId}/pin`)).user);
    } catch (e) {
      alert(errorMessage(e));
    }
  }

  const active = users?.filter((u) => u.status === "active").length ?? 0;

  return (
    <section>
      <PageTitle en="User" ja="ユーザ管理" />
      {error && <p className="error">{error}</p>}
      {users && (
        <p className="muted">
          {t(`登録 ${active} 名`, `${active} registered`)}
          {users.length > active &&
            t(`（解除済み ${users.length - active} 名）`, ` (${users.length - active} unlinked)`)}
        </p>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("表示名", "Name")}</th>
              <th className="num">{t("ポイント", "Points")}</th>
              <th className="num">{t("アップロード", "Uploads")}</th>
              <th className="num">{t("公開", "Public")}</th>
              <th className="num">{t("選ばれた", "Favorited")}</th>
              <th className="num">{t("選んだ", "Gave")}</th>
              <th className="num">{t("ゲーム点", "Game pts")}</th>
              <th>{t("状態", "Status")}</th>
              <th>{t("暗証番号", "PIN")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users?.map((u) => (
              <tr key={u.userId} className={u.status === "unbound" ? "dimmed" : undefined}>
                <td>{u.displayName}</td>
                <td className="num">
                  <strong>{u.points}</strong>
                </td>
                <td className="num">{u.uploadCount}</td>
                <td className="num">{u.approvedCount}</td>
                <td className="num">{u.favoritesReceived}</td>
                <td className="num">{u.favoritesGiven}</td>
                <td className="num">{u.gamePoints}</td>
                <td>{u.status === "active" ? t("登録済み", "Active") : t("解除済み", "Unlinked")}</td>
                <td className={u.pin === "locked" ? "pin-locked nowrap" : "nowrap"}>
                  {u.status === "active" && u.pin ? t(...PIN_LABEL[u.pin]) : ""}
                </td>
                <td>
                  <div className="actions">
                    <button type="button" onClick={() => setEditing(u)}>
                      {t("編集", "Edit")}
                    </button>
                    {u.status === "active" && u.pin === "locked" && (
                      <button type="button" onClick={() => unlockPin(u)}>
                        {t("ロック解除", "Unlock")}
                      </button>
                    )}
                    {u.status === "active" && u.pin !== undefined && u.pin !== "none" && (
                      <button type="button" onClick={() => clearPin(u)}>
                        {t("暗証番号を消す", "Clear PIN")}
                      </button>
                    )}
                    {u.status === "active" && (
                      <button type="button" className="danger" onClick={() => unbind(u)}>
                        {t("紐づけ解除", "Unlink")}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <EditUserDialog
          user={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(u) => {
            replace(u);
            setEditing(undefined);
          }}
        />
      )}
    </section>
  );
}

function EditUserDialog(props: { user: UserDto; onClose: () => void; onSaved: (user: UserDto) => void }) {
  const t = useT();
  const [name, setName] = useState(props.user.name);
  const [epithet, setEpithet] = useState(props.user.epithet);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const res = await api<UserResponse>("PATCH", `/admin/users/${props.user.userId}`, { name, epithet });
      props.onSaved(res.user);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal className="dialog" label={t("ユーザの編集", "Edit user")} onClose={props.onClose} closable={!saving}>
      <form className="card" onSubmit={onSubmit}>
        <h2>{t("ユーザの編集", "Edit user")}</h2>
        <label className="field">
          <span>{t("二つ名", "Title (二つ名)")}</span>
          <input value={epithet} onChange={(e) => setEpithet(e.target.value)} maxLength={20} required />
        </label>
        <label className="field">
          <span>{t("名前", "Name")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} required />
        </label>
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
