import { Hono } from "hono";
import { type Env, fail } from "./http.js";
import { InvalidCursorError } from "./repository.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { API_BASE_PATH, type AppDeps, createContext } from "./routes/context.js";
import { registerCspReportRoute } from "./routes/csp-report.js";
import { registerGameRoutes } from "./routes/games.js";
import { registerPhotoRoutes } from "./routes/photos.js";
import { registerPrizeRoutes } from "./routes/prizes.js";
import { registerRankingRoutes } from "./routes/ranking.js";
import { registerScheduleRoutes } from "./routes/schedule.js";
import { safeEqual } from "./session.js";

export type { AppDeps } from "./routes/context.js";

/** CloudFront が API へのリクエストに付けるヘッダ（infra/lib/partally-stack.ts の ORIGIN_VERIFY_HEADER） */
const ORIGIN_VERIFY_HEADER = "x-origin-verify";

export function createApp(deps: AppDeps) {
  const ctx = createContext(deps);
  const app = new Hono<Env>().basePath(API_BASE_PATH);

  app.onError((err, c) => {
    // 一覧の続きを読む位置（cursor）は利用者から送られるので、読めないものは利用者の誤りとして 400 にする
    if (err instanceof InvalidCursorError) return fail(c, 400, "bad_request", "一覧の続きを読む位置が正しくありません");
    console.error(err);
    return fail(c, 500, "internal_error");
  });
  app.notFound((c) => fail(c, 404, "not_found"));

  // CloudFront を通ったリクエストだけを受ける。API Gateway の元の URL に直接送られたものは、応答のヘッダ（CloudFront で付ける）や
  // 接続元（CloudFront-Viewer-Address。管理者のログインの試行回数を数えるのに使う）を迂回・偽装できるため断る
  const { originVerifySecret } = deps;
  if (originVerifySecret) {
    app.use("*", async (c, next) => {
      if (!safeEqual(c.req.header(ORIGIN_VERIFY_HEADER) ?? "", originVerifySecret)) return fail(c, 403, "forbidden");
      await next();
    });
  }

  // CSP の違反の報告（application/csp-report で届く）。JSON だけを受ける確かめより前に登録する
  registerCspReportRoute(app);

  // 更新系は JSON に限定する。クロスオリジンからの JSON 送信はプリフライトが必要になるため CSRF 対策になる
  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const type = c.req.header("content-type") ?? "";
      if (!type.startsWith("application/json")) {
        return fail(c, 415, "bad_request", "Content-Type は application/json にしてください");
      }
    }
    await next();
  });

  // 管理者の認証。どの領域の /admin/* の処理よりも先に付ける（Hono は登録した順に通す）
  app.use("/admin/*", ctx.requireAdmin);

  registerAuthRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerRankingRoutes(app, ctx);
  registerPhotoRoutes(app, ctx);
  registerPrizeRoutes(app, ctx);
  registerScheduleRoutes(app, ctx);
  registerGameRoutes(app, ctx);

  return app;
}
