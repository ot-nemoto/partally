import { issueTokensRequestSchema, updateSettingsRequestSchema, updateUserRequestSchema } from "@partally/shared";
import type { Hono } from "hono";
import { toTokenDto, toUserDto } from "../dto.js";
import { type Env, fail, parseBody } from "../http.js";
import { EpithetTakenError, NotFoundError } from "../repository.js";
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
    const [users, settings, scores] = await Promise.all([repo.listUsers(), repo.getSettings(), scoresOfAll()]);
    return c.json({ users: users.map((u) => toUserDto(u, settings, scores(u.userId))) });
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

  app.get("/admin/settings", async (c) => c.json({ settings: await repo.getSettings() }));

  app.put("/admin/settings", async (c) => {
    const body = await parseBody(c, updateSettingsRequestSchema);
    if (!body.ok) return body.response;
    const settings = { ...(await repo.getSettings()), ...body.data };
    await repo.putSettings(settings);
    return c.json({ settings });
  });
}
