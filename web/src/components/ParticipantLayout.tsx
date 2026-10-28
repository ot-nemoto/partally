import type { CurrentQuizDto, CurrentQuizResponse, MeResponse, Rules, UserDto } from "@partally/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useOutletContext } from "react-router-dom";
import { ApiError, api, errorMessage } from "../api";
import { ReloadProvider } from "../hooks/useReload";

export interface ParticipantContext {
  user: UserDto;
  /** ポイントやお気に入りのルール（管理画面の設定） */
  rules: Rules;
  /** アップロード数などを取り直す */
  reloadUser: () => void;
  /** API の応答で受け取った最新のユーザ情報に差し替える */
  setUser: (user: UserDto) => void;
  /** 出題中のクイズ（無ければ null、確認前は undefined） */
  quiz: CurrentQuizDto | null | undefined;
  /** 回答の応答で受け取った最新の状態に差し替える */
  setQuiz: (quiz: CurrentQuizDto | null) => void;
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

  // 「更新」での取り直しは、通信エラーでは画面を切り替えない（ログアウト状態になったときだけ反映する）
  const refreshQuietly = useCallback(
    () =>
      api<MeResponse>("GET", "/me")
        .then((res) =>
          setState((prev) => (prev.kind === "user" ? { ...prev, user: res.user, rules: res.rules } : prev)),
        )
        .catch((e) => {
          if (e instanceof ApiError && e.status === 401) setState({ kind: "guest" });
        }),
    [],
  );

  const setUser = useCallback(
    (user: UserDto) => setState((prev) => (prev.kind === "user" ? { ...prev, user } : prev)),
    [],
  );

  const [quiz, setQuizState] = useState<CurrentQuizDto | null>();
  const loggedIn = useRef(false);
  loggedIn.current = state.kind === "user";
  // 回答した回数。確認の途中で回答されたら、古い応答で回答を上書きしない
  const answerCount = useRef(0);
  const setQuiz = useCallback((next: CurrentQuizDto | null) => {
    answerCount.current++;
    setQuizState(next);
  }, []);
  const refreshQuiz = useCallback(async () => {
    if (!loggedIn.current) return;
    const startedAt = answerCount.current;
    await api<CurrentQuizResponse>("GET", "/quiz/current")
      .then((res) => {
        if (answerCount.current === startedAt) setQuizState(res.quiz);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (state.kind === "user") void refreshQuiz();
  }, [state.kind, refreshQuiz]);

  // 自動では取り直さない。「更新」で自分の情報・ルール・出題中のクイズと、表示中の画面の一覧を取り直す
  const [reloadCount, setReloadCount] = useState(0);
  const [reloading, setReloading] = useState(false);
  const reload = useCallback(async () => {
    setReloading(true);
    setReloadCount((n) => n + 1);
    await Promise.all([refreshQuietly(), refreshQuiz()]);
    setReloading(false);
  }, [refreshQuietly, refreshQuiz]);
  const location = useLocation();

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
        {quiz && location.pathname !== "/quiz" && (
          <Link to="/quiz" className="quiz-banner">
            <strong>問題が出ています</strong>
            <span className="quiz-banner-sub">
              {quiz.myChoiceId ? "回答済み（締め切りまで選び直せます）" : "タップして回答する"}
            </span>
          </Link>
        )}
        <ReloadProvider value={reloadCount}>
          <Outlet
            context={
              { user: state.user, rules: state.rules, reloadUser, setUser, quiz, setQuiz } satisfies ParticipantContext
            }
          />
        </ReloadProvider>
      </main>
      <nav className="tabbar">
        <NavLink to="/" end>
          ホーム
        </NavLink>
        <NavLink to="/gallery">みんなの写真</NavLink>
        <NavLink to="/mine">自分の写真</NavLink>
        <button type="button" className="tabbar-reload" onClick={reload} disabled={reloading}>
          {reloading ? "更新中…" : "↻ 更新"}
        </button>
      </nav>
    </div>
  );
}
