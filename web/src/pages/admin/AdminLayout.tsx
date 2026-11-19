import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
// ADMIN と見出し（PageTitle）の英字の書体。同じオリジンから配信し（外部への通信で表示を待たせない）、
// 管理画面を開いたときだけ読み込む。読み込むまでは system-ui で表示する
import "@fontsource/righteous/latin-400.css";
import { api } from "../../api";
import { useHeightVar } from "../../hooks/useHeightVar";
import { ReloadProvider } from "../../hooks/useReload";
import { LanguageSwitch, useT } from "../../i18n";

/** 管理画面の共通レイアウト。未ログインならログイン画面へ送る */
export function AdminLayout() {
  const navigate = useNavigate();
  const t = useT();
  const [ready, setReady] = useState(false);
  // 自動では取り直さない。「更新」で表示中の画面の一覧を取り直す（設定画面は入力中の値を残すため対象外）
  const [reloadCount, setReloadCount] = useState(0);
  const onSettings = useLocation().pathname.startsWith("/admin/settings");

  useEffect(() => {
    api("GET", "/admin/me")
      .then(() => setReady(true))
      .catch(() => navigate("/admin/login", { replace: true }));
  }, [navigate]);

  async function logout() {
    await api("POST", "/admin/logout").catch(() => undefined);
    navigate("/admin/login", { replace: true });
  }

  // 固定したヘッダーの高さを CSS 変数にし、その下に固定する行（Settings の保存・推移の再生）の位置を合わせる
  const headerRef = useRef<HTMLElement>(null);
  useHeightVar(headerRef, "--admin-header-height", ready);

  if (!ready) return <main className="page muted">{t("読み込み中…", "Loading…")}</main>;

  return (
    <div className="admin">
      {/*
        ヘッダーはスクロールしても画面の上に残す。スマホ幅ではメニューを下の段に分け、固定するのは上の段だけにする
        （メニューはどちらか一方だけが表示され、もう一方は読み上げからも外れる）
      */}
      <header className="admin-header" ref={headerRef}>
        <strong className="admin-brand gradient-title" lang="en">
          ADMIN
        </strong>
        <AdminNav className="admin-nav-inline" />
        <LanguageSwitch className="admin-lang admin-lang-inline" />
        {!onSettings && (
          <button type="button" className="link" onClick={() => setReloadCount((n) => n + 1)}>
            {t("↻ 更新", "↻ Refresh")}
          </button>
        )}
        <button type="button" className="link" onClick={logout}>
          {t("ログアウト", "Log out")}
        </button>
      </header>
      <AdminNav className="admin-nav-below" />
      {/* スマホ幅では、言語の切り替えをメニューの下に置く（ヘッダーの 1 段目に収まらないため） */}
      <div className="admin-lang-row">
        <LanguageSwitch className="admin-lang" />
      </div>
      <main className="admin-main">
        <ReloadProvider value={reloadCount}>
          <Outlet />
        </ReloadProvider>
      </main>
    </div>
  );
}

function AdminNav({ className }: { className: string }) {
  return (
    <nav className={`admin-nav ${className}`} lang="en">
      <NavLink to="/admin/tokens">QR</NavLink>
      <NavLink to="/admin/users">User</NavLink>
      <NavLink to="/admin/ranking">Ranking</NavLink>
      <NavLink to="/admin/trend">Trend</NavLink>
      <NavLink to="/admin/photos">Photo</NavLink>
      <NavLink to="/admin/games">Game</NavLink>
      <NavLink to="/admin/prizes">Prize</NavLink>
      <NavLink to="/admin/schedule">Schedule</NavLink>
      <NavLink to="/admin/settings">Setting</NavLink>
      <NavLink to="/admin/data">Data</NavLink>
    </nav>
  );
}
