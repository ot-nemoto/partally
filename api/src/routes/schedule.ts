import {
  arrangeScheduleColumns,
  placedScheduleHidden,
  SCHEDULE_COLUMNS_MAX,
  scheduleColumnRequestSchema,
  scheduleItemRequestSchema,
  visibleSchedule,
} from "@partally/shared";
import type { Hono } from "hono";
import { sortSchedule, toScheduleItemDto } from "../dto.js";
import { type Env, fail, parseBody } from "../http.js";
import { NotFoundError, type ScheduleItemRecord, type ScheduleLayoutChange } from "../repository.js";
import type { AppContext } from "./context.js";

export function registerScheduleRoutes(app: Hono<Env>, ctx: AppContext) {
  const { repo, now, newId, requireUser } = ctx;

  /**
   * 項目を作った・直した・消した後に、列と見せるかを決め直して保存する。
   * - 列（arrangeScheduleColumns）: placed（作った・直した項目）が同じ列のほかの項目と重なれば、すぐ右に列を足して移し、何もない列は詰める
   * - 見せるか（placedScheduleHidden）: placed を置いた列にほかの項目があれば、その列に合わせる
   * 一覧の索引は結果整合で、直前に書いた項目がまだ出ないことがあるので、書いた項目は手で入れ替え、消した項目は除く。
   * 決めた列（項目ごと）と、見せるかを決め直した placed を返す
   */
  async function settleLayout(change: { placed?: ScheduleItemRecord; removedId?: string }) {
    const listed = await repo.listScheduleItems();
    const others = listed.filter((i) => i.itemId !== change.placed?.itemId && i.itemId !== change.removedId);
    const items = change.placed ? [...others, change.placed] : others;
    const columns = arrangeScheduleColumns(items, change.placed?.itemId);
    const hidden = change.placed && placedScheduleHidden(items, change.placed.itemId);
    const changes: ScheduleLayoutChange[] = [];
    for (const i of items) {
      const column = columns.get(i.itemId)!;
      const hiddenChanged = i === change.placed && hidden !== (i.hidden === true);
      if (i.column === column && !hiddenChanged) continue;
      changes.push({
        itemId: i.itemId,
        ...(i.column === column ? {} : { column }),
        ...(hiddenChanged ? { hidden } : {}),
      });
    }
    if (changes.length > 0) await repo.setScheduleLayout(changes);
    return { columns, placed: change.placed && { ...change.placed, hidden } };
  }

  // 参加者に見せるスケジュール。見せない設定のときは無いものとして扱う
  app.get("/schedule", requireUser, async (c) => {
    const settings = await repo.getSettings();
    if (!settings.scheduleVisible) return fail(c, 404, "not_found");
    // 見せない列の項目は出さず、残った列を詰める
    const items = visibleSchedule(sortSchedule(await repo.listScheduleItems()));
    return c.json({ items, date: settings.scheduleDate });
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
    const { columns, placed } = await settleLayout({ placed: item });
    return c.json({ item: toScheduleItemDto(placed!, columns.get(item.itemId) ?? 0) }, 201);
  });

  // 列を参加者に見せるか。その列の項目をまとめて切り替える（列は今の並びでの番号）
  app.put("/admin/schedule/columns/:column", async (c) => {
    const column = Number(c.req.param("column"));
    if (!Number.isInteger(column) || column < 0 || column >= SCHEDULE_COLUMNS_MAX) return fail(c, 404, "not_found");
    const body = await parseBody(c, scheduleColumnRequestSchema);
    if (!body.ok) return body.response;
    const [listed, settings] = await Promise.all([repo.listScheduleItems(), repo.getSettings()]);
    const columns = arrangeScheduleColumns(listed);
    const targets = listed.filter((i) => columns.get(i.itemId) === column);
    if (targets.length === 0) return fail(c, 404, "not_found");
    // 列を持たない項目は、ついでに今の列を保存する
    await repo.setScheduleLayout(targets.map((i) => ({ itemId: i.itemId, column, hidden: body.data.hidden })));
    const items = listed.map((i) => (columns.get(i.itemId) === column ? { ...i, hidden: body.data.hidden } : i));
    return c.json({ items: sortSchedule(items), date: settings.scheduleDate });
  });

  app.put("/admin/schedule/:itemId", async (c) => {
    const body = await parseBody(c, scheduleItemRequestSchema);
    if (!body.ok) return body.response;
    try {
      // 列・見せるかを省いたら今のまま
      const item = await repo.updateScheduleItem(c.req.param("itemId"), body.data, now().toISOString());
      const { columns, placed } = await settleLayout({ placed: item });
      return c.json({ item: toScheduleItemDto(placed!, columns.get(item.itemId) ?? 0) });
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
    await settleLayout({ removedId: itemId });
    return c.json({});
  });
}
