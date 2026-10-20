import { parsePhotoKey, type PhotoStorage } from "./photo-storage.js";
import type { Repository } from "./repository.js";

export interface IngestDeps {
  repo: Repository;
  storage: PhotoStorage;
  now?: () => Date;
}

export type IngestResult = "created" | "duplicate" | "ignored";

/**
 * pending 領域に本体画像が置かれたときに呼ぶ。アップロードを検証して写真を登録する。
 * クライアントはサムネイル → 本体の順に送るので、本体が届いた時点でサムネイルも揃っている。
 */
export async function ingestUpload(deps: IngestDeps, key: string): Promise<IngestResult> {
  const { repo, storage, now = () => new Date() } = deps;
  const parsed = parsePhotoKey(key);
  if (!parsed || parsed.area !== "pending" || parsed.kind !== "full") return "ignored";
  const { photoId } = parsed;

  const uploaderId = await storage.getUploader(key);
  if (!uploaderId) {
    console.warn(`アップロード者が不明なため無視します: ${key}`);
    return "ignored";
  }
  const thumbUploader = await storage.getUploader(key.replace(/full\.jpg$/, "thumb.jpg"));
  if (thumbUploader !== uploaderId) {
    console.warn(`サムネイルが無いか、アップロード者が一致しないため無視します: ${key}`);
    return "ignored";
  }
  const user = await repo.getUser(uploaderId);
  if (!user || user.status !== "active") {
    console.warn(`アップロード者 ${uploaderId} が有効なユーザではないため無視します: ${key}`);
    return "ignored";
  }

  const { moderation } = await repo.getSettings();
  const immediate = moderation === "post";
  if (immediate) await storage.copyToApproved(photoId);

  const created = await repo.createPhoto({
    photoId,
    uploaderId,
    status: immediate ? "approved" : "pending",
    createdAt: now().toISOString(),
  });
  if (immediate) await storage.remove(photoId, "pending");
  return created ? "created" : "duplicate";
}
