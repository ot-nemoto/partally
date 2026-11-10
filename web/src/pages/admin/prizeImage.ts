import type { ImageUploadResponse, PresignedPost } from "@partally/shared";
import { api } from "../../api";

/** 景品の画像（縮小済みの JPEG）を受け口へアップロードし、景品に付ける imageId を返す */
export function uploadPrizeImage(jpeg: Blob): Promise<string> {
  return uploadImage("/admin/prizes/image-upload", jpeg);
}

/** ゲームの画像（問題・選択肢。縮小済みの JPEG）を受け口へアップロードし、ゲームに付ける imageId を返す */
export function uploadGameImage(jpeg: Blob): Promise<string> {
  return uploadImage("/admin/games/image-upload", jpeg);
}

async function uploadImage(path: string, jpeg: Blob): Promise<string> {
  const res = await api<ImageUploadResponse>("POST", path);
  await upload(res.upload, jpeg);
  return res.imageId;
}

async function upload(target: PresignedPost, blob: Blob) {
  const form = new FormData();
  for (const [k, v] of Object.entries(target.fields)) form.append(k, v);
  form.append("file", blob, "image.jpg");
  const res = await fetch(target.url, { method: "POST", body: form });
  if (!res.ok) throw new Error(`画像のアップロードに失敗しました（${res.status}）`);
}
