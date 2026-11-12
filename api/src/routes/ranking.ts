import type { Hono } from "hono";
import { type Env, fail } from "../http.js";
import { toParticipantRanking } from "../scoring.js";
import type { AppContext } from "./context.js";

export function registerRankingRoutes(app: Hono<Env>, ctx: AppContext) {
  const { repo, loadRanking, requireUser } = ctx;

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

  app.get("/admin/ranking", async (c) => c.json(await loadRanking(await repo.getSettings())));
}
