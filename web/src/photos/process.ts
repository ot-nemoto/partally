import { PHOTO_FULL_MAX_EDGE, PHOTO_THUMB_MAX_EDGE } from "@partally/shared";

export interface ProcessedPhoto {
  full: Blob;
  thumb: Blob;
}

/**
 * 撮影・選択した画像を縮小して JPEG にする。再エンコードで EXIF（位置情報など）は消える。
 * 失敗した場合は元画像を送らずに例外を投げる。
 */
export async function processPhoto(file: File): Promise<ProcessedPhoto> {
  const bitmap = await decode(file);
  try {
    const full = await toJpeg(bitmap, PHOTO_FULL_MAX_EDGE, 0.8);
    const thumb = await toJpeg(bitmap, PHOTO_THUMB_MAX_EDGE, 0.7);
    return { full, thumb };
  } finally {
    bitmap.close();
  }
}

/** 画像を 1 枚だけ縮小して JPEG にする（景品の画像など） */
export async function processImage(file: File, maxEdge: number, quality = 0.85): Promise<Blob> {
  const bitmap = await decode(file);
  try {
    return await toJpeg(bitmap, maxEdge, quality);
  } finally {
    bitmap.close();
  }
}

async function decode(file: File): Promise<ImageBitmap> {
  try {
    // 向き（EXIF Orientation）を反映してデコードする。Safari は HEIC もここで読める
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (e) {
    if (!isHeic(file)) throw e;
    // HEIC を読めないブラウザ向け。変換ライブラリは大きいので必要なときだけ読み込む
    const { default: heic2any } = await import("heic2any");
    const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
    const jpeg = Array.isArray(converted) ? converted[0]! : converted;
    return createImageBitmap(jpeg, { imageOrientation: "from-image" });
  }
}

function isHeic(file: File): boolean {
  return /image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

async function toJpeg(bitmap: ImageBitmap, maxEdge: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas を使えません");
  ctx.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new Error("JPEG への変換に失敗しました");
  return blob;
}
