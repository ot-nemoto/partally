import { arrangeScheduleColumns, scheduleItemRequestSchema } from "@partally/shared";
import type { Hono } from "hono";
import { sortSchedule, toScheduleItemDto } from "../dto.js";
import { type Env, fail, parseBody } from "../http.js";
import { NotFoundError, type ScheduleItemRecord } from "../repository.js";
import type { AppContext } from "./context.js";

export function registerScheduleRoutes(app: Hono<Env>, ctx: AppContext) {
  const { repo, now, newId, requireUser } = ctx;

  /**
   * 項目を作った・直した・消した後に、列を決め直して保存する（arrangeScheduleColumns）。
   * placed（作った・直した項目）が同じ列のほかの項目と重なれば、すぐ右に列を足して移し、何もない列は詰める。
   * 一覧の索引は結果整合で、直前に書いた項目がまだ出ないことがあるので、書いた項目は手で入れ替え、消した項目は除く。
   * 決めた列（項目ごと）を返す
   */
  async function settleColumns(change: { placed?: ScheduleItemRecord; removedId?: string }) {
    const listed = await repo.listScheduleItems();
    const others = listed.filter((i) => i.itemId !== change.placed?.itemId && i.itemId !== change.removedId);
    const items = change.placed ? [...others, change.placed] : others;
    const columns = arrangeScheduleColumns(items, change.placed?.itemId);
    const changed = items
      .filter((i) => i.column !== columns.get(i.itemId))
      .map((i) => ({ itemId: i.itemId, column: columns.get(i.itemId)! }));
    if (changed.length > 0) await repo.setScheduleColumns(changed);
    return columns;
  }

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
    // 列を省いたら左端の列に置く（重なれば、すぐ右に列を足して移す）
    const item: ScheduleItemRecord = {
      itemId: newId(),
      ...body.data,
      column: body.data.column ?? 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await repo.createScheduleItem(item);
    const columns = await settleColumns({ placed: item });
    return c.json({ item: toScheduleItemDto(item, columns.get(item.itemId) ?? 0) }, 201);
  });

  app.put("/admin/schedule/:itemId", async (c) => {
    const body = await parseBody(c, scheduleItemRequestSchema);
    if (!body.ok) return body.response;
    try {
      // 列を省いたら今の列のまま
      const item = await repo.updateScheduleItem(c.req.param("itemId"), body.data, now().toISOString());
      const columns = await settleColumns({ placed: item });
      return c.json({ item: toScheduleItemDto(item, columns.get(item.itemId) ?? 0) });
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      throw e;
    }
  });

  app.delete("/admin/schedule/:itemId", async (c) => {
    const itemId = c.req.param("itemId");
    try {
      await repo.deleteScheduleItem(itemId);
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      throw e;
    }
    // 何もなくなった列を詰める
    await settleColumns({ removedId: itemId });
    return c.json({});
  });
}
