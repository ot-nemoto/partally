import {
  formatPositionLabel,
  type GameResultDto,
  type GameResultsResponse,
  gameFormatLabel,
  type ParticipantRankingResponse,
  prizesForDisplay,
  TIE_BREAK_LABEL,
  TIE_BREAK_LABEL_EN,
} from "@partally/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, errorMessage } from "../api";
import { useParticipant } from "../components/ParticipantLayout";
import { PrizeImage } from "../components/PrizeChips";
import { RankingBars } from "../components/RankingBars";
import { MAX_LINES, RankingChart } from "../components/RankingChart";
import { usePrizes } from "../hooks/usePrizes";
import { useLang, useT } from "../i18n";
import { ScheduleView } from "./ScheduleView";

type View = "schedule" | "ranking" | "trend" | "prizes" | "games";

const VIEW_LABEL: Record<View, [ja: string, en: string]> = {
  schedule: ["スケジュール", "Schedule"],
  ranking: ["ランキング", "Ranking"],
  trend: ["ポイントの推移", "Trend"],
  prizes: ["景品", "Prizes"],
  games: ["ゲームの結果", "Game results"],
};

/**
 * 参加者のスケジュール・ランキング・ポイントの推移・景品。どれを見せるか、名前・ポイントを伏せるかは管理画面の設定に従う
 * （伏せる分は API から返らない）。複数見せるときは切り替えて表示する
 */
export function Standings() {
  const { rules } = useParticipant();
  const t = useT();
  const visible: Record<View, boolean> = {
    schedule: rules.scheduleVisible,
    ranking: rules.rankingVisible,
    trend: rules.trendVisible,
    prizes: rules.prizesVisible,
    games: rules.gameResultsVisible,
  };
  const views = (["schedule", "ranking", "trend", "prizes", "games"] as const).filter((v) => visible[v]);
  const [selected, setSelected] = useState<View>();
  const view = selected && views.includes(selected) ? selected : views[0];

  return (
    <section className="ranking">
      <h1>{t("イベント情報", "Event info")}</h1>
      {views.length > 1 && (
        <div className="segmented" role="tablist">
          {views.map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              className={view === v ? "active" : undefined}
              onClick={() => setSelected(v)}
            >
              {t(...VIEW_LABEL[v])}
            </button>
          ))}
        </div>
      )}
      {view === "schedule" ? (
        <ScheduleView />
      ) : view === "prizes" ? (
        <PrizesView />
      ) : view === "games" ? (
        <GameResultsView />
      ) : view ? (
        <StandingsView key={view} view={view} withPrizes={rules.prizesVisible} />
      ) : (
        <p className="muted">{t("今は公開されていません。", "Not available right now.")}</p>
      )}
    </section>
  );
}

/** 終了したゲームごとに、正解・自分の答えと結果・入った人を見せる（終了した順。点数は見せない） */
function GameResultsView() {
  const t = useT();
  const lang = useLang();
  const [games, setGames] = useState<GameResultDto[]>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    api<GameResultsResponse>("GET", "/game-results")
      .then((res) => {
        setGames(res.games);
        setError(undefined);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  /** 自分の答えと結果を 1 行にする（答えていなければ「答えていません」） */
  const mineOf = (g: GameResultDto) => {
    if (g.format === "result") return g.myResult;
    if (!g.answered) {
      return g.format === "keyword"
        ? t("正解できませんでした", "Didn’t get it")
        : g.format === "lottery"
          ? t("参加していません", "Didn’t enter")
          : t("答えていません", "Didn’t answer");
    }
    const parts = [
      g.myAnswer,
      g.myCorrect === undefined ? undefined : g.myCorrect ? t("◯ 正解", "◯ Correct") : t("× 不正解", "× Wrong"),
      g.myResult ?? (g.format === "lottery" ? t("はずれ", "Not drawn") : undefined),
    ].filter((x) => x !== undefined);
    return parts.join(t("　", " · "));
  };

  if (error) return <p className="error">{error}</p>;
  if (!games) return <p className="muted">{t("読み込み中…", "Loading…")}</p>;
  if (games.length === 0)
    return <p className="muted">{t("まだ終了したゲームはありません。", "No games have ended yet.")}</p>;
  return (
    <ol className="game-results">
      {games.map((g) => (
        <li key={g.gameId} className="card game-result">
          <h3>
            {g.name}
            <span className="game-format small">{gameFormatLabel(g.format, lang)}</span>
          </h3>
          {g.uncounted && (
            <p className="muted small">
              {t(
                "イベントの終了の後に終了したので、ポイントには数えていません。",
                "Ended after the event ended, so it doesn’t count toward points.",
              )}
            </p>
          )}
          <dl className="game-result-rows">
            {g.correct !== undefined && (
              <>
                <dt>{t("正解", "Answer")}</dt>
                <dd>
                  <strong>{g.correct}</strong>
                </dd>
              </>
            )}
            {mineOf(g) && (
              <>
                <dt>{t("あなた", "You")}</dt>
                <dd>{mineOf(g)}</dd>
              </>
            )}
          </dl>
          {g.winners.length > 0 && (
            <ul className="game-result-awards">
              {g.winners.map((w) => (
                <li key={w.label}>
                  <strong>{w.label}</strong>
                  <p className="small">{w.names.join(t("、", ", "))}</p>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * 景品ごとに、画像・名前と何位の人に渡すかを見せる（順位ごとに並べるとランキングに見えるため）。
 * 順位は上から何番目の人か（同点は設定の優先順、それも同じなら先に登録した人を上にする）
 */
function PrizesView() {
  const { rules } = useParticipant();
  const { prizes, state } = usePrizes("/prizes");
  const t = useT();
  const lang = useLang();
  if (state === "hidden") return <p className="muted">{t("今は公開されていません。", "Not available right now.")}</p>;
  if (state === "error") {
    return (
      <p className="error">
        {t(
          "景品を読み込めませんでした。画面を下に引っ張って、読み込み直してください。",
          "Couldn’t load the prizes. Pull down the screen to reload.",
        )}
      </p>
    );
  }
  if (!prizes) return <p className="muted">{t("読み込み中…", "Loading…")}</p>;
  const shown = prizesForDisplay(prizes);
  if (shown.length === 0) return <p className="muted">{t("まだ景品はありません。", "No prizes yet.")}</p>;
  return (
    <>
      <ul className="prize-list">
        {shown.map((p) => (
          <li key={p.prizeId} className="card prize-list-item">
            <PrizeImage prize={p} />
            <h3>{p.name}</h3>
            {/* 上位（1〜3 位）を含む景品は順位を金色にする */}
            <p className={`prize-positions${Math.min(...p.positions) <= 3 ? " top" : ""}`}>
              {formatPositionLabel(p.positions, lang)}
            </p>
          </li>
        ))}
      </ul>
      {rules.tieBreakOrder?.length > 0 && (
        <p className="muted small">
          {t(
            `同じポイントの人は、${rules.tieBreakOrder.map((key) => TIE_BREAK_LABEL[key]).join(" → ")} の順に比べて順位を決めます（ポイントの項目は多い人、登録順は先に登録した人が上）。`,
            `Ties are broken by ${rules.tieBreakOrder.map((key) => TIE_BREAK_LABEL_EN[key]).join(" → ")}, in that order (more is higher; for registration order, earlier is higher).`,
          )}
        </p>
      )}
    </>
  );
}

function StandingsView({ view, withPrizes }: { view: "ranking" | "trend"; withPrizes: boolean }) {
  const { prizes } = usePrizes("/prizes", withPrizes && view === "ranking");
  const t = useT();
  const [data, setData] = useState<ParticipantRankingResponse>();
  const [error, setError] = useState<string>();
  const [hidden, setHidden] = useState(false);

  // 読み込みが重なったとき（表示を切り替えたときなど）、後から返ってきた古い応答で戻さない
  const latestRequest = useRef(0);
  const load = useCallback(() => {
    const request = ++latestRequest.current;
    api<ParticipantRankingResponse>("GET", `/${view}`)
      .then((res) => {
        if (request !== latestRequest.current) return;
        setData(res);
        setHidden(false);
        setError(undefined);
      })
      .catch((e) => {
        if (request !== latestRequest.current) return;
        // 見ている間に非公開にされた
        const notPublic = e instanceof ApiError && e.status === 404;
        setHidden(notPublic);
        setError(notPublic ? undefined : errorMessage(e));
      });
  }, [view]);
  useEffect(load, [load]);

  // 推移は上位の人を色付きにし、ほかは灰色の線で出す
  const series = useMemo(
    () => (data?.ranking ?? []).slice(0, MAX_LINES).map((entry, slot) => ({ entry, slot })),
    [data],
  );

  if (hidden) return <p className="muted">{t("今は公開されていません。", "Not available right now.")}</p>;
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">{t("読み込み中…", "Loading…")}</p>;
  if (data.ranking.length === 0) return <p className="muted">{t("まだ参加者がいません。", "No participants yet.")}</p>;

  return (
    <>
      {view === "ranking" ? (
        <RankingBars ranking={data.ranking} hidePoints={data.hidePoints} prizes={prizes} />
      ) : (
        <div className="card ranking-chart">
          <h2>{t("累計ポイントの推移", "Total points over time")}</h2>
          <p className="muted small">
            {t(
              `上位 ${Math.min(MAX_LINES, data.ranking.length)} 人を色付きで表示しています。`,
              `The top ${Math.min(MAX_LINES, data.ranking.length)} are shown in color.`,
            )}
          </p>
          <RankingChart all={data.ranking} series={series} end={data.generatedAt} hidePoints={data.hidePoints} />
        </div>
      )}
      <p className="muted small">
        {t("最新にするには、画面を下に引っ張って読み込み直してください。", "Pull down the screen to update.")}
      </p>
    </>
  );
}
