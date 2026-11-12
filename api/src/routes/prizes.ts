import { prizeRequestSchema } from "@partally/shared";
import type { Hono } from "hono";
import { type Env, fail, parseBody } from "../http.js";
import { NotFoundError, type PrizeRecord } from "../repository.js";
import type { AppContext } from "./context.js";

export function registerPrizeRoutes(app: Hono<Env>, ctx: AppContext) {
  const { repo, now, newId, toPrizeDto, requireUser, removePrizeImage, createImageUpload, attachImages } = ctx;

  // 参加者に見せる景品。見せない設定のときは無いものとして扱う
  app.get("/prizes", requireUser, async (c) => {
    const settings = await repo.getSettings();
    if (!settings.prizesVisible) return fail(c, 404, "not_found");
    return c.json({ prizes: (await repo.listPrizes()).map(toPrizeDto) });
  });

  app.get("/admin/prizes", async (c) => c.json({ prizes: (await repo.listPrizes()).map(toPrizeDto) }));

  app.post("/admin/prizes/image-upload", createImageUpload);

  app.post("/admin/prizes", async (c) => {
    const body = await parseBody(c, prizeRequestSchema);
    if (!body.ok) return body.response;
    const images = await attachImages(c, body.data.imageId ? [body.data.imageId] : []);
    if (images.response) return images.response;
    const timestamp = now().toISOString();
    const prize: PrizeRecord = {
      prizeId: newId(),
      name: body.data.name,
      quantity: body.data.quantity,
      positions: [...body.data.positions].sort((a, b) => a - b),
      imageId: body.data.imageId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      await repo.createPrize(prize);
    } catch (e) {
      if (prize.imageId) await removePrizeImage(prize.imageId);
      throw e;
    }
    return c.json({ prize: toPrizeDto(prize) }, 201);
  });

  app.put("/admin/prizes/:prizeId", async (c) => {
    const body = await parseBody(c, prizeRequestSchema);
    if (!body.ok) return body.response;
    const prize = await repo.getPrize(c.req.param("prizeId"));
    if (!prize) return fail(c, 404, "not_found");
    const images = await attachImages(
      c,
      body.data.imageId ? [body.data.imageId] : [],
      prize.imageId ? [prize.imageId] : [],
    );
    if (images.response) return images.response;
    try {
      const updated = await repo.updatePrize(
        prize.prizeId,
        {
          name: body.data.name,
          quantity: body.data.quantity,
          positions: [...body.data.positions].sort((a, b) => a - b),
          imageId: body.data.imageId,
        },
        now().toISOString(),
      );
      // 差し替えた・外した画像は、保存できてから消す
      if (prize.imageId && prize.imageId !== updated.imageId) await removePrizeImage(prize.imageId);
      return c.json({ prize: toPrizeDto(updated) });
    } catch (e) {
      // 保存できなかったら、新しく移した画像を消す
      if (body.data.imageId && body.data.imageId !== prize.imageId) await removePrizeImage(body.data.imageId);
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      throw e;
    }
  });

  app.delete("/admin/prizes/:prizeId", async (c) => {
    const prize = await repo.getPrize(c.req.param("prizeId"));
    if (!prize) return fail(c, 404, "not_found");
    try {
      await repo.deletePrize(prize.prizeId);
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      throw e;
    }
    if (prize.imageId) await removePrizeImage(prize.imageId);
    return c.json({});
  });
}
