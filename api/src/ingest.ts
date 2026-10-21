import { type PhotoStorage, parsePhotoKey } from "./photo-storage.js";
import type { Repository } from "./repository.js";

export interface IngestDeps {
  repo: Repository;
  storage: PhotoStorage;
  now?: () => Date;
}

export type IngestResult = "created" | "duplicate" | "ignored";

/**
 * uploads 領域に本体画像が置かれたときに呼ぶ。アップロードを検証し、検閲待ち（即時公開なら公開済み）へ
 * サーバ側でコピーしてから写真を登録する。クライアントはサムネイル → 本体の順に送るので、
 * 本体が届いた時点でサムネイルも揃っている。
 */
export async function ingestUpload(deps: IngestDeps, key: string): Promise<IngestResult> {
  const { repo, storage, now = () => new Date() } = deps;
  const parsed = parsePhotoKey(key);
  if (parsed?.area !== "uploads" || parsed.kind !== "full") return "ignored";
  const { photoId } = parsed;

  // 一度取り込んだ photoId は（却下・削除後も）受け付けない。署名付き POST は有効期限内なら何度でも使えるため、
  // 再アップロードで検閲済みの画像を差し替えたり、削除した写真を復活させたりできないようにする
  if (await repo.getPhoto(photoId)) {
    await storage.remove(photoId, "uploads");
    return "duplicate";
  }

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
  if (user?.status !== "active") {
    console.warn(`アップロード者 ${uploaderId} が有効なユーザではないため無視します: ${key}`);
    return "ignored";
  }

  const { moderation } = await repo.getSettings();
  const status = moderation === "post" ? "approved" : "pending";
  await storage.copy(photoId, "uploads", status);
  const created = await repo.createPhoto({
    photoId,
    uploaderId,
    status,
    favoriteCount: 0,
    createdAt: now().toISOString(),
  });
  await storage.remove(photoId, "uploads");
  return created ? "created" : "duplicate";
}
