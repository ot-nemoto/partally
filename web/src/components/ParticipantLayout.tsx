import type { CurrentGameDto, CurrentGameResponse, MeResponse, Rules, UserDto } from "@partally/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useOutletContext } from "react-router-dom";
import { ApiError, api, errorMessage } from "../api";
import { useAutoRefresh } from "../hooks/useAutoRefresh";
import { ReloadProvider } from "../hooks/useReload";

/** 開催・確定にすぐ気づけるよう、表示中はこの間隔で開催中のゲームを確認する（文字だけの小さな通信） */
const GAME_REFRESH_MS = 5_000;

export interface ParticipantContext {
  user: UserDto;
  /** ポイントやお気に入りのルール（管理画面の設定） */
  rules: Rules;
  /** アップロード数などを取り直す */
  reloadUser: () => void;
  /** API の応答で受け取った最新のユーザ情報に差し替える */
  setUser: (user: UserDto) => void;
  /** 開催中のゲーム（無ければ null、確認前は undefined） */
  game: CurrentGameDto | null | undefined;
  /** 答えの応答で受け取った最新の状態に差し替える */
  setGame: (game: CurrentGameDto | null) => void;
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

  const [game, setGameState] = useState<CurrentGameDto | null>();
  const loggedIn = useRef(false);
  loggedIn.current = state.kind === "user";
  // 答えと確認のたびに増やす。確認の途中で答えたり、後から送った確認が先に返ったりしたら、
  // 古い応答で上書きしない（遅い通信で確定前の応答が後から届き、お知らせが戻るのを防ぐ）
  const gameVersion = useRef(0);
  const setGame = useCallback((next: CurrentGameDto | null) => {
    gameVersion.current++;
    setGameState(next);
  }, []);
  const refreshGame = useCallback(async () => {
    if (!loggedIn.current) return;
    const version = ++gameVersion.current;
    await api<CurrentGameResponse>("GET", "/game/current")
      .then((res) => {
        if (gameVersion.current === version) setGameState(res.game);
      })
      .catch((e) => {
        // ログインが切れたら案内の画面にする（確認も止まる）。通信エラーは次の確認に任せる
        if (e instanceof ApiError && e.status === 401) setState({ kind: "guest" });
      });
  }, []);
  useEffect(() => {
    if (state.kind === "user") void refreshGame();
  }, [state.kind, refreshGame]);
  useAutoRefresh(refreshGame, GAME_REFRESH_MS);

  // ゲーム以外は自動では取り直さない。「更新」で自分の情報・ルール・開催中のゲームと、表示中の画面の一覧を取り直す
  const [reloadCount, setReloadCount] = useState(0);
  const [reloading, setReloading] = useState(false);
  const reload = useCallback(async () => {
    setReloading(true);
    setReloadCount((n) => n + 1);
    await Promise.all([refreshQuietly(), refreshGame()]);
    setReloading(false);
  }, [refreshQuietly, refreshGame]);
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
        {game && location.pathname !== "/game" && (
          <Link to="/game" className="quiz-banner">
            <strong>{game.format === "result" ? "ゲーム開催中" : "問題が出ています"}</strong>
            <span className="quiz-banner-sub">
              {game.format === "quiz"
                ? game.myChoiceId
                  ? `${game.name}・回答済み（締め切りまで選び直せます）`
                  : `${game.name}・タップして回答する`
                : game.format === "number"
                  ? game.myValue !== undefined
                    ? `${game.name}・回答済み（締め切りまで答え直せます）`
                    : `${game.name}・タップして数を予想する`
                  : `${game.name}・タップして見る`}
            </span>
          </Link>
        )}
        <ReloadProvider value={reloadCount}>
          <Outlet
            context={
              { user: state.user, rules: state.rules, reloadUser, setUser, game, setGame } satisfies ParticipantContext
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
        {/* ランキング・推移は管理画面で見せる設定にしたときだけ出す */}
        {(state.rules.rankingVisible ||
          state.rules.trendVisible ||
          state.rules.prizesVisible ||
          state.rules.scheduleVisible) && <NavLink to="/standings">イベント情報</NavLink>}
        <button type="button" className="tabbar-reload" onClick={reload} disabled={reloading}>
          {reloading ? "更新中…" : "↻ 更新"}
        </button>
      </nav>
    </div>
  );
}
