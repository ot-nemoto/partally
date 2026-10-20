import type { UserDto, UserResponse, UsersResponse } from "@partally/shared";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../api";

export function AdminUsers() {
  const [users, setUsers] = useState<UserDto[]>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<UserDto>();

  const load = useCallback(() => {
    api<UsersResponse>("GET", "/admin/users")
      .then((res) => setUsers(res.users))
      .catch((e) => setError(errorMessage(e)));
  }, []);

  useEffect(load, [load]);

  function replace(user: UserDto) {
    setUsers((prev) => prev?.map((u) => (u.userId === user.userId ? user : u)));
  }

  async function unbind(user: UserDto) {
    if (
      !confirm(
        `${user.displayName} と QR コードの紐づけを解除します。\n本人は再ログインできなくなり、その QR は新規登録用に戻ります。よろしいですか？`,
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

  const active = users?.filter((u) => u.status === "active").length ?? 0;

  return (
    <section>
      <h1>ユーザ管理</h1>
      {error && <p className="error">{error}</p>}
      {users && (
        <p className="muted">
          登録 {active} 名{users.length > active && `（解除済み ${users.length - active} 名）`}
        </p>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>表示名</th>
              <th className="num">アップロード</th>
              <th className="num">公開</th>
              <th>状態</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users?.map((u) => (
              <tr key={u.userId} className={u.status === "unbound" ? "dimmed" : undefined}>
                <td>{u.displayName}</td>
                <td className="num">{u.uploadCount}</td>
                <td className="num">{u.approvedCount}</td>
                <td>{u.status === "active" ? "登録済み" : "解除済み"}</td>
                <td>
                  <div className="actions">
                    <button type="button" onClick={() => setEditing(u)}>
                      編集
                    </button>
                    {u.status === "active" && (
                      <button type="button" className="danger" onClick={() => unbind(u)}>
                        紐づけ解除
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
    <div className="dialog-backdrop" onClick={props.onClose}>
      <form className="card dialog" onSubmit={onSubmit} onClick={(e) => e.stopPropagation()}>
        <h2>ユーザの編集</h2>
        <label className="field">
          <span>二つ名</span>
          <input value={epithet} onChange={(e) => setEpithet(e.target.value)} maxLength={20} required />
        </label>
        <label className="field">
          <span>名前</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} required />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="buttons">
          <button type="button" onClick={props.onClose}>
            キャンセル
          </button>
          <button type="submit" className="primary" disabled={saving}>
            保存
          </button>
        </div>
      </form>
    </div>
  );
}
