// ログイン前の画面のタイトルに、管理画面の見出しと同じ英字の書体を使う
import "@fontsource/righteous/latin-400.css";
import {
  type CurrentGameDto,
  type CurrentGameResponse,
  gameBannerText,
  type MeResponse,
  type Rules,
  roundBannerText,
  type UserDto,
} from "@partally/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useOutletContext } from "react-router-dom";
import { ApiError, api, errorMessage } from "../api";
import { useAutoRefresh } from "../hooks/useAutoRefresh";
import { LanguageSwitch, useLang, useT } from "../i18n";
import { UserSwitch } from "./UserSwitch";

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
  /** 開催中のゲーム（ラウンドなら出す順の全問。無ければ空、確認前は undefined） */
  games: CurrentGameDto[] | undefined;
  /** 開催中のラウンド（1 問だけのときは無い） */
  round?: { roundId: string; name: string };
  /** 答えの応答で受け取った最新のゲームに差し替える */
  setGame: (game: CurrentGameDto) => void;
  /** 終わったことが分かったとき、開催中のゲームを無くす */
  closeGames: () => void;
  /** 開催中のゲームを読み直す */
  refreshGames: () => Promise<void>;
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
  /** 表示中の参加者。読み直したら別の人になっていた（端末で覚えているほかの人に切り替わった）ときに気づくため */
  const shownUserId = useRef<string | undefined>(undefined);
  /** 参加者の画面を表示しているか（描画のたびに今の状態に合わせる） */
  const loggedIn = useRef(false);
  loggedIn.current = state.kind === "user";

  /**
   * 自分の情報を読み直す。今の参加者が使えなくなっていたら（紐づけ解除など）、サーバがこの端末で覚えている
   * ほかの参加者に切り替えて返すので、そのときは表示中の情報をすべてその人のものにするため画面を開き直す。
   * 通信やサーバのエラーで画面全体をエラーの表示にするのは、参加者の画面を表示していないとき（初めて読むときなど）だけ。
   * 表示している間の読み直し（ホームを開いたときなど）で電波が切れても、撮影のボタンや送信待ちの写真が消えないよう、
   * 表示はそのままにする
   */
  const loadMe = useCallback(
    () =>
      api<MeResponse>("GET", "/me")
        .then((res) => {
          if (shownUserId.current && shownUserId.current !== res.user.userId) {
            window.location.reload();
            return;
          }
          shownUserId.current = res.user.userId;
          setState({ kind: "user", user: res.user, rules: res.rules });
        })
        .catch((e) => {
          if (e instanceof ApiError && e.status === 401) {
            setState({ kind: "guest" });
            return;
          }
          if (!loggedIn.current) {
            setState({ kind: "error", message: errorMessage(e) });
            return;
          }
          // 表示を保つために捨てたエラーも、不具合に気づけるようコンソールには残す
          console.warn("自分の情報を読み直せなかったので、今の表示のままにします", e);
        }),
    [],
  );
  const reloadUser = useCallback(() => void loadMe(), [loadMe]);

  useEffect(reloadUser, [reloadUser]);

  const setUser = useCallback(
    (user: UserDto) => setState((prev) => (prev.kind === "user" ? { ...prev, user } : prev)),
    [],
  );

  const [current, setCurrent] = useState<Pick<CurrentGameResponse, "games" | "round">>();
  // 答えと確認のたびに増やす。確認の途中で答えたり、後から送った確認が先に返ったりしたら、
  // 古い応答で上書きしない（遅い通信で確定前の応答が後から届き、お知らせが戻るのを防ぐ）
  const gameVersion = useRef(0);
  const setGame = useCallback((next: CurrentGameDto) => {
    gameVersion.current++;
    setCurrent((prev) => prev && { ...prev, games: prev.games.map((g) => (g.gameId === next.gameId ? next : g)) });
  }, []);
  const closeGames = useCallback(() => {
    gameVersion.current++;
    setCurrent({ games: [] });
  }, []);
  const refreshGame = useCallback(async () => {
    if (!loggedIn.current) return;
    const version = ++gameVersion.current;
    await api<CurrentGameResponse>("GET", "/game/current")
      .then((res) => {
        // 前の版の API（games が無い）でも 1 問として読む
        if (gameVersion.current === version) {
          setCurrent({ games: res.games ?? (res.game ? [res.game] : []), round: res.round });
        }
      })
      .catch((e) => {
        // ログインが切れたら、自分の情報を読み直す（この端末で覚えているほかの参加者がいれば、その人に切り替わる。
        // いなければ案内の画面になり、確認も止まる）。通信エラーは次の確認に任せる
        if (e instanceof ApiError && e.status === 401) reloadUser();
      });
  }, [reloadUser]);
  useEffect(() => {
    if (state.kind === "user") void refreshGame();
  }, [state.kind, refreshGame]);
  useAutoRefresh(refreshGame, GAME_REFRESH_MS);

  // ゲーム以外は自動では取り直さない。最新にするときは、ブラウザで画面を下に引っ張って読み込み直す（#294）
  const location = useLocation();
  const t = useT();
  const lang = useLang();

  if (state.kind === "loading") return <main className="page muted">{t("読み込み中…", "Loading…")}</main>;
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
        <div className="lang-row">
          <LanguageSwitch />
        </div>
        <section className="card guest-card">
          <h1 className="guest-title gradient-title" lang="en">
            partally
          </h1>
          <p>
            {t(
              "配布された QR コードをスマホのカメラで読み込んでください。",
              "Scan the QR code you were given with your phone’s camera.",
            )}
          </p>
        </section>
        <p className="small privacy-link">
          <Link to="/privacy">{t("データの扱い", "How we handle your data")}</Link>
        </p>
      </main>
    );
  }

  const games = current?.games ?? [];
  const banner =
    games.length === 0 || location.pathname === "/game"
      ? undefined
      : current?.round
        ? roundBannerText(current.round, games, lang)
        : gameBannerText(games[0]!, lang);

  return (
    <div className="participant">
      <main className="page">
        {/* 上の段：参加者の切り替え（2 人以上覚えているとき。すべての画面）と、ホームでは言語の切り替え */}
        <div className="top-row">
          <UserSwitch />
          {location.pathname === "/" && <LanguageSwitch />}
        </div>
        {/* イベントを終了した後は、ポイントの集計が止まったことを知らせる（受付は続く） */}
        {state.rules.eventEndedAt && (
          <p className="event-ended" role="status">
            {t(
              "イベントは終了しました。ポイントの集計は終わりました。",
              "The event has ended. Points are no longer counted.",
            )}
          </p>
        )}
        {banner && (
          <Link to="/game" className="quiz-banner">
            <strong>{banner.title}</strong>
            <span className="quiz-banner-sub">{banner.note}</span>
          </Link>
        )}
        <Outlet
          context={
            {
              user: state.user,
              rules: state.rules,
              reloadUser,
              setUser,
              games: current?.games,
              round: current?.round,
              setGame,
              closeGames,
              refreshGames: refreshGame,
            } satisfies ParticipantContext
          }
        />
      </main>
      <nav className="tabbar">
        <NavLink to="/" end>
          {t("ホーム", "Home")}
        </NavLink>
        <NavLink to="/gallery">{t("みんなの写真", "Everyone")}</NavLink>
        <NavLink to="/mine">{t("自分の写真", "My photos")}</NavLink>
        {/* ランキング・推移は管理画面で見せる設定にしたときだけ出す */}
        {(state.rules.rankingVisible ||
          state.rules.trendVisible ||
          state.rules.prizesVisible ||
          state.rules.scheduleVisible ||
          state.rules.gameResultsVisible) && <NavLink to="/standings">{t("イベント情報", "Event info")}</NavLink>}
      </nav>
    </div>
  );
}
