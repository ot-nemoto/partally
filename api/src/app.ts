import { Hono } from "hono";
import { type Env, fail } from "./http.js";
import { InvalidCursorError } from "./repository.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { type AppDeps, createContext } from "./routes/context.js";
import { registerGameRoutes } from "./routes/games.js";
import { registerPhotoRoutes } from "./routes/photos.js";
import { registerPrizeRoutes } from "./routes/prizes.js";
import { registerRankingRoutes } from "./routes/ranking.js";
import { registerScheduleRoutes } from "./routes/schedule.js";

export type { AppDeps } from "./routes/context.js";

export function createApp(deps: AppDeps) {
  const ctx = createContext(deps);
  const app = new Hono<Env>().basePath("/api");

  app.onError((err, c) => {
    // 一覧の続きを読む位置（cursor）は利用者から送られるので、読めないものは利用者の誤りとして 400 にする
    if (err instanceof InvalidCursorError) return fail(c, 400, "bad_request", "一覧の続きを読む位置が正しくありません");
    console.error(err);
    return fail(c, 500, "internal_error");
  });
  app.notFound((c) => fail(c, 404, "not_found"));

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

  // 管理者の認証（/admin/*）は、ほかの管理者の処理より先に登録する
  registerAuthRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerRankingRoutes(app, ctx);
  registerPhotoRoutes(app, ctx);
  registerPrizeRoutes(app, ctx);
  registerScheduleRoutes(app, ctx);
  registerGameRoutes(app, ctx);

  return app;
}
