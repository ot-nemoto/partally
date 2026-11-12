import { prizeRequestSchema } from "@partally/shared";
import type { Context, Hono } from "hono";
import { type Env, fail, parseBody } from "../http.js";
import { NotFoundError, type PrizeRecord } from "../repository.js";
import type { AppContext } from "./context.js";

export function registerPrizeRoutes(app: Hono<Env>, ctx: AppContext) {
  const { repo, storage, now, newId, toPrizeDto, requireUser, removePrizeImage } = ctx;

  // 参加者に見せる景品。見せない設定のときは無いものとして扱う
  app.get("/prizes", requireUser, async (c) => {
    const settings = await repo.getSettings();
    if (!settings.prizesVisible) return fail(c, 404, "not_found");
    return c.json({ prizes: (await repo.listPrizes()).map(toPrizeDto) });
  });

  app.get("/admin/prizes", async (c) => c.json({ prizes: (await repo.listPrizes()).map(toPrizeDto) }));

  app.post("/admin/prizes/image-upload", async (c) => {
    const imageId = newId();
    return c.json({ imageId, upload: await storage.createPrizeImageUpload(imageId) });
  });

  /** 新しく付ける画像を受け口から配信する領域へ移す。受け口に無ければ 400 のレスポンスを返す */
  const attachPrizeImage = async (c: Context, imageId: string | undefined, current?: string) => {
    if (imageId === undefined || imageId === current) return undefined;
    if (await storage.attachPrizeImage(imageId)) return undefined;
    return fail(c, 400, "bad_request", "画像がアップロードされていないか、ほかで使われています");
  };

  app.post("/admin/prizes", async (c) => {
    const body = await parseBody(c, prizeRequestSchema);
    if (!body.ok) return body.response;
    const invalid = await attachPrizeImage(c, body.data.imageId);
    if (invalid) return invalid;
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
    const invalid = await attachPrizeImage(c, body.data.imageId, prize.imageId);
    if (invalid) return invalid;
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
