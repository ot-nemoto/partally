import type { ImageUploadResponse, PresignedPost } from "@partally/shared";
import { ApiError, api } from "../../api";

/** 景品の画像（縮小済みの JPEG）を受け口へアップロードし、景品に付ける imageId を返す */
export function uploadPrizeImage(jpeg: Blob): Promise<string> {
  return uploadImage("/admin/prizes/image-upload", jpeg);
}

/** ゲームの画像（問題・選択肢。縮小済みの JPEG）を受け口へアップロードし、ゲームに付ける imageId を返す */
export function uploadGameImage(jpeg: Blob): Promise<string> {
  return uploadImage("/admin/games/image-upload", jpeg);
}

/**
 * 保存し直すときに、同じ画像をアップロードし直さないための覚え書き（ダイアログごとに 1 つ作る）。
 * 保存に失敗しても、アップロードした画像は受け口に残っているので、次の保存で使い回す
 */
export class ImageUploads {
  private readonly ids = new Map<Blob, string>();
  private reused = false;

  constructor(private readonly upload: (jpeg: Blob) => Promise<string>) {}

  /** 画像をアップロードして imageId を返す。前の保存でアップロードした画像なら、その imageId を返す */
  async idOf(jpeg: Blob): Promise<string> {
    const saved = this.ids.get(jpeg);
    if (saved) {
      this.reused = true;
      return saved;
    }
    const imageId = await this.upload(jpeg);
    this.ids.set(jpeg, imageId);
    return imageId;
  }

  /**
   * 保存を送る。サーバは、画像を移した後に保存できなかったとき、移した画像を消す。使い回した画像がそうして
   * 片付けられていた（image_not_uploaded）ときだけ、アップロードし直してもう一度送る
   */
  async save<T>(send: () => Promise<T>): Promise<T> {
    this.reused = false;
    try {
      return await send();
    } catch (err) {
      if (!(this.reused && err instanceof ApiError && err.code === "image_not_uploaded")) throw err;
      this.ids.clear();
      this.reused = false;
      return await send();
    }
  }
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
