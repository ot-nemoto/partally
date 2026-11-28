import { prizePositions, prizesByPosition, type StandingResponse } from "@partally/shared";
import type { Hono } from "hono";
import { type Env, fail } from "../http.js";
import { toParticipantRanking } from "../scoring.js";
import type { AppContext } from "./context.js";

export function registerRankingRoutes(app: Hono<Env>, ctx: AppContext) {
  const { repo, loadRanking, requireUser, toPrizeDto } = ctx;

  // 参加者に見せるランキング・推移。見せない設定のときは無いものとして扱う。
  // 合計・順位は写真・お気に入り・ゲームのすべてのポイントで出す（ホーム画面の表示設定とは別）
  app.get("/ranking", requireUser, async (c) => {
    const settings = await repo.getSettings();
    if (!settings.rankingVisible) return fail(c, 404, "not_found");
    const ranking = await loadRanking(settings);
    // 横棒だけなので推移は返さない
    const entries = ranking.ranking.map((e) => ({ ...e, history: [] }));
    return c.json(
      toParticipantRanking({ ...ranking, ranking: entries }, settings.rankingHideNames, settings.rankingHidePoints),
    );
  });

  app.get("/trend", requireUser, async (c) => {
    const settings = await repo.getSettings();
    if (!settings.trendVisible) return fail(c, 404, "not_found");
    return c.json(toParticipantRanking(await loadRanking(settings), settings.trendHideNames, settings.trendHidePoints));
  });

  // イベントを終了した後に、ホーム画面で発表する自分の順位と景品。終了していない間と、どちらも見せない設定のときは無いものとして扱う。
  // 順位は終了した時点のポイントで決まり、景品と同じく紐づけを解除した人を除いて数える
  app.get("/me/standing", requireUser, async (c) => {
    const [settings, end] = await Promise.all([repo.getSettings(), repo.getEventEnd()]);
    if (!end || !(settings.homeRankVisible || settings.homePrizeVisible)) return fail(c, 404, "not_found");
    const [ranking, prizes] = await Promise.all([
      loadRanking(settings),
      settings.homePrizeVisible ? repo.listPrizes() : Promise.resolve([]),
    ]);
    const rank = prizePositions(ranking.ranking).get(c.get("user").userId);
    const mine = rank === undefined ? [] : (prizesByPosition(prizes.map(toPrizeDto)).get(rank) ?? []);
    return c.json({
      ...(settings.homeRankVisible && rank !== undefined ? { rank } : {}),
      ...(settings.homePrizeVisible ? { prizes: mine } : {}),
    } satisfies StandingResponse);
  });

  app.get("/admin/ranking", async (c) => c.json(await loadRanking(await repo.getSettings())));
}
