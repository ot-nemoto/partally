import type { CurrentQuizDto, CurrentQuizResponse, MeResponse, Rules, UserDto } from "@partally/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useOutletContext } from "react-router-dom";
import { ApiError, api, errorMessage } from "../api";
import { useAutoRefresh } from "../hooks/useAutoRefresh";

/** 管理画面での設定の変更（お気に入りの受付・ポイントの表示）を反映するため、表示中はこの間隔で自分の情報とルールを取り直す */
const RULES_REFRESH_MS = 30_000;
/** 出題に気づけるよう、表示中はこの間隔で出題中のクイズを確認する */
const QUIZ_REFRESH_MS = 5_000;

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

  const [quiz, setQuiz] = useState<CurrentQuizDto | null>();
  const loggedIn = useRef(false);
  loggedIn.current = state.kind === "user";
  const refreshQuiz = useCallback(() => {
    if (!loggedIn.current) return;
    api<CurrentQuizResponse>("GET", "/quiz/current")
      .then((res) => setQuiz(res.quiz))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (state.kind === "user") refreshQuiz();
  }, [state.kind, refreshQuiz]);
  useAutoRefresh(refreshQuiz, QUIZ_REFRESH_MS);
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
        <Outlet
          context={
            { user: state.user, rules: state.rules, reloadUser, setUser, quiz, setQuiz } satisfies ParticipantContext
          }
        />
      </main>
      <nav className="tabbar">
        <NavLink to="/" end>
          ホーム
        </NavLink>
        <NavLink to="/gallery">みんなの写真</NavLink>
        <NavLink to="/mine">自分の写真</NavLink>
      </nav>
    </div>
  );
}
