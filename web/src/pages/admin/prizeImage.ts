import type { PresignedPost, PrizeImageUploadResponse } from "@partally/shared";
import { api } from "../../api";

/** 景品の画像（縮小済みの JPEG）を受け口へアップロードし、景品に付ける imageId を返す */
export async function uploadPrizeImage(jpeg: Blob): Promise<string> {
  const res = await api<PrizeImageUploadResponse>("POST", "/admin/prizes/image-upload");
  await upload(res.upload, jpeg);
  return res.imageId;
}

async function upload(target: PresignedPost, blob: Blob) {
  const form = new FormData();
  for (const [k, v] of Object.entries(target.fields)) form.append(k, v);
  form.append("file", blob, "prize.jpg");
  const res = await fetch(target.url, { method: "POST", body: form });
  if (!res.ok) throw new Error(`画像のアップロードに失敗しました（${res.status}）`);
}
