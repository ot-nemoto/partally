import { issueTokensRequestSchema, updateSettingsRequestSchema, updateUserRequestSchema } from "@partally/shared";
import type { Hono } from "hono";
import { toTokenDto, toUserDto } from "../dto.js";
import { type Env, fail, parseBody } from "../http.js";
import { EpithetTakenError, InvalidStateError, NotFoundError } from "../repository.js";
import { snapshotCounts } from "../scoring.js";
import type { AppContext } from "./context.js";

export function registerAdminRoutes(app: Hono<Env>, ctx: AppContext) {
  const { repo, now, newToken, scoresOfAll, adminUser } = ctx;

  app.post("/admin/tokens", async (c) => {
    const body = await parseBody(c, issueTokensRequestSchema);
    if (!body.ok) return body.response;
    const tokens = Array.from({ length: body.data.count }, newToken);
    const created = await repo.createTokens(tokens, now().toISOString());
    return c.json({ tokens: created.map((t) => toTokenDto(t)) }, 201);
  });

  app.get("/admin/tokens", async (c) => {
    const [tokens, users] = await Promise.all([repo.listTokens(), repo.listUsers()]);
    const byId = new Map(users.map((u) => [u.userId, u]));
    return c.json({ tokens: tokens.map((t) => toTokenDto(t, t.userId ? byId.get(t.userId) : undefined)) });
  });

  app.get("/admin/users", async (c) => {
    const end = await repo.getEventEnd();
    const [users, settings, scores] = await Promise.all([repo.listUsers(), repo.getSettings(), scoresOfAll(end)]);
    return c.json({ users: users.map((u) => toUserDto(u, settings, scores(u.userId), end)) });
  });

  // ---- イベントの終了（押した時刻より後の出来事をポイントに数えない。受付は続ける） ----

  app.get("/admin/event", async (c) => c.json({ endedAt: (await repo.getEventEnd())?.endedAt }));

  app.post("/admin/event/end", async (c) => {
    // 開催中のゲームは、終了した後に確定してもポイントに数えないので、先に終了か中断をしてもらう
    const [games, rounds] = await Promise.all([repo.listGames(), repo.listRounds()]);
    if (games.some((g) => g.status === "open") || rounds.some((r) => r.status === "open")) {
      return fail(
        c,
        409,
        "invalid_state",
        "開催中のゲームがあります。ゲームを終了するか中断してから、イベントを終了してください",
      );
    }
    // 押した時点の全員の数を残す（この後の写真・お気に入りは数えない）
    const endedAt = now().toISOString();
    const counts = snapshotCounts(await repo.listUsers());
    try {
      await repo.putEventEnd({ endedAt, counts });
    } catch (e) {
      if (e instanceof InvalidStateError) return fail(c, 409, "invalid_state", "イベントは既に終了しています");
      throw e;
    }
    return c.json({ endedAt });
  });

  app.post("/admin/event/reopen", async (c) => {
    await repo.deleteEventEnd();
    return c.json({});
  });

  app.patch("/admin/users/:userId", async (c) => {
    const body = await parseBody(c, updateUserRequestSchema);
    if (!body.ok) return body.response;
    try {
      const user = await repo.updateUser(c.req.param("userId"), body.data, now().toISOString());
      return c.json({ user: await adminUser(user) });
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      if (e instanceof EpithetTakenError) return fail(c, 409, "epithet_taken");
      throw e;
    }
  });

  app.post("/admin/users/:userId/unbind", async (c) => {
    try {
      const user = await repo.unbindUser(c.req.param("userId"), now().toISOString());
      return c.json({ user: await adminUser(user) });
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      throw e;
    }
  });

  // 暗証番号のロックを解除する（間違えた回数を 0 に戻す）
  app.post("/admin/users/:userId/pin/unlock", async (c) => {
    try {
      return c.json({ user: await adminUser(await repo.resetPinFailures(c.req.param("userId"))) });
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      throw e;
    }
  });

  // 暗証番号を消す（忘れた人。次にほかの端末で QR コードを読み込んだときに決め直す）
  app.delete("/admin/users/:userId/pin", async (c) => {
    try {
      return c.json({ user: await adminUser(await repo.clearUserPin(c.req.param("userId"))) });
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      throw e;
    }
  });

  app.get("/admin/settings", async (c) => c.json({ settings: await repo.getSettings() }));

  app.put("/admin/settings", async (c) => {
    const body = await parseBody(c, updateSettingsRequestSchema);
    if (!body.ok) return body.response;
    const settings = { ...(await repo.getSettings()), ...body.data };
    await repo.putSettings(settings);
    return c.json({ settings });
  });
}
