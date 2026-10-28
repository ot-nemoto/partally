import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { api } from "../../api";
import { ReloadProvider } from "../../hooks/useReload";

/** 管理画面の共通レイアウト。未ログインならログイン画面へ送る */
export function AdminLayout() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  // 自動では取り直さない。「更新」で表示中の画面の一覧を取り直す（設定画面は入力中の値を残すため対象外）
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    api("GET", "/admin/me")
      .then(() => setReady(true))
      .catch(() => navigate("/admin/login", { replace: true }));
  }, [navigate]);

  async function logout() {
    await api("POST", "/admin/logout").catch(() => undefined);
    navigate("/admin/login", { replace: true });
  }

  if (!ready) return <main className="page muted">読み込み中…</main>;

  return (
    <div className="admin">
      <header className="admin-header">
        <strong>partally 管理</strong>
        <nav>
          <NavLink to="/admin/users">ユーザ</NavLink>
          <NavLink to="/admin/ranking">ランキング</NavLink>
          <NavLink to="/admin/tokens">QR</NavLink>
          <NavLink to="/admin/photos">写真</NavLink>
          <NavLink to="/admin/quizzes">クイズ</NavLink>
          <NavLink to="/admin/settings">設定</NavLink>
        </nav>
        <button type="button" className="link" onClick={() => setReloadCount((n) => n + 1)}>
          ↻ 更新
        </button>
        <button type="button" className="link" onClick={logout}>
          ログアウト
        </button>
      </header>
      <main className="admin-main">
        <ReloadProvider value={reloadCount}>
          <Outlet />
        </ReloadProvider>
      </main>
    </div>
  );
}
