import { scheduleItemRequestSchema } from "@partally/shared";
import type { Hono } from "hono";
import { sortSchedule, toScheduleItemDto } from "../dto.js";
import { type Env, fail, parseBody } from "../http.js";
import { NotFoundError, type ScheduleItemRecord } from "../repository.js";
import type { AppContext } from "./context.js";

export function registerScheduleRoutes(app: Hono<Env>, ctx: AppContext) {
  const { repo, now, newId, requireUser } = ctx;

  // 参加者に見せるスケジュール。見せない設定のときは無いものとして扱う
  app.get("/schedule", requireUser, async (c) => {
    const settings = await repo.getSettings();
    if (!settings.scheduleVisible) return fail(c, 404, "not_found");
    return c.json({ items: sortSchedule(await repo.listScheduleItems()), date: settings.scheduleDate });
  });

  app.get("/admin/schedule", async (c) => {
    const [items, settings] = await Promise.all([repo.listScheduleItems(), repo.getSettings()]);
    return c.json({ items: sortSchedule(items), date: settings.scheduleDate });
  });

  app.post("/admin/schedule", async (c) => {
    const body = await parseBody(c, scheduleItemRequestSchema);
    if (!body.ok) return body.response;
    const timestamp = now().toISOString();
    const item: ScheduleItemRecord = { itemId: newId(), ...body.data, createdAt: timestamp, updatedAt: timestamp };
    await repo.createScheduleItem(item);
    return c.json({ item: toScheduleItemDto(item) }, 201);
  });

  app.put("/admin/schedule/:itemId", async (c) => {
    const body = await parseBody(c, scheduleItemRequestSchema);
    if (!body.ok) return body.response;
    try {
      const item = await repo.updateScheduleItem(c.req.param("itemId"), body.data, now().toISOString());
      return c.json({ item: toScheduleItemDto(item) });
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      throw e;
    }
  });

  app.delete("/admin/schedule/:itemId", async (c) => {
    try {
      await repo.deleteScheduleItem(c.req.param("itemId"));
      return c.json({});
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      throw e;
    }
  });
}
