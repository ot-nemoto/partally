import type { MeResponse, Rules, UserDto } from "@partally/shared";
import { useCallback, useEffect, useState } from "react";
import { NavLink, Outlet, useOutletContext } from "react-router-dom";
import { ApiError, api, errorMessage } from "../api";
import { useAutoRefresh } from "../hooks/useAutoRefresh";

/** お気に入りの受付の開始・終了をタブに反映するため、表示中はこの間隔で自分の情報とルールを取り直す */
const RULES_REFRESH_MS = 30_000;

export interface ParticipantContext {
  user: UserDto;
  /** ポイントやお気に入りのルール（管理画面の設定） */
  rules: Rules;
  /** アップロード数などを取り直す */
  reloadUser: () => void;
  /** API の応答で受け取った最新のユーザ情報に差し替える */
  setUser: (user: UserDto) => void;
}

export function useParticipant() {
  return useOutletContext<ParticipantContext>();
}

type State =
  | { kind: "loading" }
  | { kind: "guest" }
  | { kind: "user"; user: UserDto; rules: Rules }
  | { kind: "error"; message: string };

/** 参加者向け画面の共通レイアウト。/api/me で写真用 Cookie も更新される */
export function ParticipantLayout() {
  const [state, setState] = useState<State>({ kind: "loading" });

  const reloadUser = useCallback(() => {
    api<MeResponse>("GET", "/me")
      .then((res) => setState({ kind: "user", user: res.user, rules: res.rules }))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) setState({ kind: "guest" });
        else setState({ kind: "error", message: errorMessage(e) });
      });
  }, []);

  useEffect(reloadUser, [reloadUser]);

  // 裏での取り直しは、通信エラーでは画面を切り替えない（ログアウト状態になったときだけ反映する）
  const refreshQuietly = useCallback(() => {
    api<MeResponse>("GET", "/me")
      .then((res) => setState((prev) => (prev.kind === "user" ? { ...prev, user: res.user, rules: res.rules } : prev)))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) setState({ kind: "guest" });
      });
  }, []);
  useAutoRefresh(refreshQuietly, RULES_REFRESH_MS);

  const setUser = useCallback(
    (user: UserDto) => setState((prev) => (prev.kind === "user" ? { ...prev, user } : prev)),
    [],
  );

  if (state.kind === "loading") return <main className="page muted">読み込み中…</main>;
  if (state.kind === "error") {
    return (
      <main className="page">
        <p className="error">{state.message}</p>
      </main>
    );
  }
  if (state.kind === "guest") {
    return (
      <main className="page">
        <section className="card">
          <h1>partally</h1>
          <p>配布された QR コードをスマホのカメラで読み込んでください。</p>
        </section>
      </main>
    );
  }

  return (
    <div className="participant">
      <main className="page">
        <Outlet context={{ user: state.user, rules: state.rules, reloadUser, setUser } satisfies ParticipantContext} />
      </main>
      <nav className="tabbar">
        <NavLink to="/" end>
          ホーム
        </NavLink>
        <NavLink to="/gallery">みんなの写真</NavLink>
        {state.rules.favoritesEnabled && <NavLink to="/favorites">お気に入り</NavLink>}
        <NavLink to="/mine">自分の写真</NavLink>
      </nav>
    </div>
  );
}
