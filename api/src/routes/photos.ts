import {
  PHOTO_PENDING_MAX,
  PHOTO_UPLOAD_MAX_PER_WINDOW,
  PHOTO_UPLOAD_WINDOW_MS,
  photoStatusSchema,
} from "@partally/shared";
import type { Context, Hono } from "hono";
import { isVisible, type VisiblePhoto } from "../dto.js";
import { type Env, fail } from "../http.js";
import { FavoriteLimitError, InvalidStateError, NotFoundError, type PhotoRecord } from "../repository.js";
import type { AppContext } from "./context.js";

const PHOTO_PAGE_SIZE = 30;

/** 写真の状態遷移を実行し、想定内の失敗は API エラーのレスポンスにする */
async function photoAction(c: Context, action: () => Promise<PhotoRecord>): Promise<PhotoRecord | Response> {
  try {
    return await action();
  } catch (e) {
    if (e instanceof NotFoundError) return fail(c, 404, "not_found");
    if (e instanceof InvalidStateError) return fail(c, 409, "invalid_state");
    throw e;
  }
}

export function registerPhotoRoutes(app: Hono<Env>, ctx: AppContext) {
  const { repo, storage, now, newId, setPhotoCookies, toPhotoDto, uploadersOf, participantUser, requireUser } = ctx;

  app.post("/photos/upload-url", requireUser, async (c) => {
    const user = c.get("user");
    // 確認待ちが多いときは、幹事が確認するまで送らせない（検閲待ちの一覧と保存先を埋めさせない）。
    // 投稿数（uploadCount）は確認待ちと公開中の数なので、公開数を引くと確認待ちの数になる
    if (user.uploadCount - user.approvedCount >= PHOTO_PENDING_MAX) {
      return fail(c, 429, "too_many_pending", `確認待ちの写真が ${PHOTO_PENDING_MAX} 枚あります`);
    }
    // 短い間に枠を取りすぎないよう、区切りごとに数える（断ったものは数えない）
    const nowMs = now().getTime();
    const start = Math.floor(nowMs / PHOTO_UPLOAD_WINDOW_MS) * PHOTO_UPLOAD_WINDOW_MS;
    const expiresAt = Math.floor((start + PHOTO_UPLOAD_WINDOW_MS) / 1000) + 60 * 60;
    if (
      !(await repo.reserveUploadSlot(
        user.userId,
        new Date(start).toISOString(),
        PHOTO_UPLOAD_MAX_PER_WINDOW,
        expiresAt,
      ))
    ) {
      const seconds = Math.max(1, Math.ceil((start + PHOTO_UPLOAD_WINDOW_MS - nowMs) / 1000));
      c.header("Retry-After", String(seconds));
      return fail(c, 429, "upload_rate_limited", `あと ${Math.ceil(seconds / 60)} 分`);
    }
    const photoId = newId();
    const { full, thumb } = await storage.createUploads(photoId, user.userId);
    return c.json({ photoId, full, thumb });
  });

  // 一覧を開いたままの画面でも写真が見え続けるよう、一覧の取得時にも写真用 Cookie を更新する
  app.get("/photos", requireUser, async (c) => {
    const [page, favoriteIds, settings] = await Promise.all([
      repo.listPhotosByStatus("approved", PHOTO_PAGE_SIZE, c.req.query("cursor")),
      repo.listFavoritePhotoIds(c.get("user").userId),
      repo.getSettings(),
    ]);
    const users = await uploadersOf(page.items);
    const favorites = new Set(favoriteIds);
    setPhotoCookies(c);
    return c.json({
      photos: page.items
        .filter(isVisible)
        .map((p) => toPhotoDto(p, users, { favorites, hideCounts: !settings.showPoints })),
      cursor: page.cursor,
    });
  });

  app.get("/photos/mine", requireUser, async (c) => {
    const user = c.get("user");
    const [photos, settings] = await Promise.all([repo.listPhotosByUploader(user.userId), repo.getSettings()]);
    const users = new Map([[user.userId, user]]);
    setPhotoCookies(c);
    return c.json({
      photos: photos.filter(isVisible).map((p) => toPhotoDto(p, users, { hideCounts: !settings.showPoints })),
    });
  });

  /** お気に入りの追加・解除。無効にされている間は締め切りとして、どちらも受け付けない */
  const changeFavorite = async (c: Context<Env>, action: "add" | "remove") => {
    const settings = await repo.getSettings();
    if (!settings.favoritesEnabled) return fail(c, 409, "favorites_disabled");
    const user = c.get("user");
    const photo = await repo.getPhoto(c.req.param("photoId") ?? "");
    if (!photo) return fail(c, 404, "not_found");
    if (photo.uploaderId === user.userId) return fail(c, 409, "invalid_state", "自分の写真は選べません");
    try {
      if (action === "add") await repo.addFavorite(user.userId, photo, settings.favoriteLimit, now().toISOString());
      else await repo.removeFavorite(user.userId, photo);
    } catch (e) {
      if (e instanceof FavoriteLimitError) return fail(c, 409, "favorite_limit");
      if (e instanceof InvalidStateError) return fail(c, 409, "invalid_state");
      throw e;
    }
    const [updatedPhoto, updatedUser, uploaders] = await Promise.all([
      repo.getPhoto(photo.photoId),
      repo.getUser(user.userId),
      uploadersOf([photo]),
    ]);
    if (!updatedPhoto || !isVisible(updatedPhoto) || !updatedUser) return fail(c, 404, "not_found");
    return c.json({
      photo: toPhotoDto(updatedPhoto, uploaders, {
        favorites: new Set(action === "add" ? [photo.photoId] : []),
        hideCounts: !settings.showPoints,
      }),
      user: await participantUser(updatedUser, settings),
    });
  };

  app.put("/photos/:photoId/favorite", requireUser, (c) => changeFavorite(c, "add"));
  app.delete("/photos/:photoId/favorite", requireUser, (c) => changeFavorite(c, "remove"));

  app.get("/admin/photos", async (c) => {
    const status = photoStatusSchema.safeParse(c.req.query("status") ?? "pending");
    if (!status.success) return fail(c, 400, "bad_request");
    const page = await repo.listPhotosByStatus(status.data, PHOTO_PAGE_SIZE, c.req.query("cursor"));
    const users = await uploadersOf(page.items);
    return c.json({
      photos: page.items.filter(isVisible).map((p) => toPhotoDto(p, users, { signAll: true })),
      cursor: page.cursor,
    });
  });

  /**
   * 承認・却下の後に、検閲待ちの画像を消す。状態は保存できているので、消せなくても失敗にはしない
   * （やり直すと、もう検閲待ちではないので 409 になってしまう。検閲待ちの画像は署名付き URL でしか見えず、残っても Reset で消える）
   */
  const removePending = async (photoId: string) => {
    try {
      await storage.remove(photoId, "pending");
    } catch (e) {
      console.error(`写真 ${photoId} の検閲待ちの画像を消せませんでした`, e);
    }
  };

  app.post("/admin/photos/:photoId/approve", async (c) => {
    const photoId = c.req.param("photoId");
    const photo = await repo.getPhoto(photoId);
    if (!photo) return fail(c, 404, "not_found");
    if (photo.status !== "pending") return fail(c, 409, "invalid_state");
    // 画像を先に公開領域へコピーし、DB を更新してから検閲待ちの画像を消す
    try {
      await storage.copy(photoId, "pending", "approved");
    } catch (e) {
      // 同時に別の承認・却下が先に済んで、検閲待ちの画像がもう無いとき（古い値を読まないよう、強い整合性で読む）
      if ((await repo.getPhoto(photoId, { consistent: true }))?.status !== "pending") {
        return fail(c, 409, "invalid_state");
      }
      throw e;
    }
    const approved = await photoAction(c, () => repo.approvePhoto(photoId, now().toISOString()));
    if (approved instanceof Response) {
      // DB の更新に失敗したら、公開領域へのコピーを取り消す。ただし同時に別の承認が先に済んでいたら、
      // その承認が公開した画像なので消さない（消すと、公開中のまま画像が無くなり元に戻せない）。
      // 直前の承認を見落とさないよう、強い整合性で読む
      if ((await repo.getPhoto(photoId, { consistent: true }))?.status !== "approved") {
        await storage.remove(photoId, "approved");
      }
      return approved;
    }
    await removePending(photoId);
    return c.json({ photo: toPhotoDto(approved as VisiblePhoto, await uploadersOf([approved]), { signAll: true }) });
  });

  app.post("/admin/photos/:photoId/reject", async (c) => {
    const photoId = c.req.param("photoId");
    const rejected = await photoAction(c, () => repo.rejectPhoto(photoId, now().toISOString()));
    if (rejected instanceof Response) return rejected;
    await removePending(photoId);
    return c.json({ photo: toPhotoDto(rejected as VisiblePhoto, await uploadersOf([rejected]), { signAll: true }) });
  });

  app.delete("/admin/photos/:photoId", async (c) => {
    const photoId = c.req.param("photoId");
    const photo = await repo.getPhoto(photoId);
    if (!photo) return fail(c, 404, "not_found");
    // 削除済みでも後片付けをやり直せるようにする（途中で失敗したときの再実行用）
    if (photo.status !== "deleted") {
      const deleted = await photoAction(c, () => repo.deleteApprovedPhoto(photoId, now().toISOString()));
      if (deleted instanceof Response) return deleted;
    }
    // 画像を先に消して見えなくしてから、お気に入りを外す（選んだ人の枠とアップロード者のポイントを戻す）
    await storage.remove(photoId, "approved");
    await storage.invalidate(photoId);
    await repo.clearFavorites(photoId);
    return c.json({});
  });
}
