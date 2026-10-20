import type { PresignedPost } from "@partally/shared";
import { type PhotoArea, type PhotoKind, type PhotoStorage, photoKey } from "./photo-storage.js";

interface StoredObject {
  data: Uint8Array<ArrayBuffer>;
  uploader: string;
}

const KINDS: PhotoKind[] = ["full", "thumb"];

/** ローカル開発・テスト用。S3 の代わりにメモリ上に保存する */
export class MemoryPhotoStorage implements PhotoStorage {
  readonly objects = new Map<string, StoredObject>();
  readonly invalidated: string[] = [];

  /** @param uploadUrl 署名付き POST の代わりに使うアップロード先（ローカル開発サーバのエンドポイント） */
  constructor(private readonly uploadUrl = "/__dev/upload") {}

  async createUploads(photoId: string, uploaderId: string) {
    const post = (kind: PhotoKind): PresignedPost => ({
      url: this.uploadUrl,
      fields: {
        key: photoKey("uploads", photoId, kind),
        "Content-Type": "image/jpeg",
        "x-amz-meta-uploader": uploaderId,
      },
    });
    return { full: post("full"), thumb: post("thumb") };
  }

  put(key: string, data: Uint8Array<ArrayBuffer>, uploader: string) {
    this.objects.set(key, { data, uploader });
  }

  get(key: string): Uint8Array<ArrayBuffer> | undefined {
    return this.objects.get(key)?.data;
  }

  async getUploader(key: string) {
    return this.objects.get(key)?.uploader;
  }

  async copy(photoId: string, from: PhotoArea, to: Exclude<PhotoArea, "uploads">) {
    for (const kind of KINDS) {
      const obj = this.objects.get(photoKey(from, photoId, kind));
      if (!obj) throw new Error(`コピー元がありません: ${photoKey(from, photoId, kind)}`);
      this.objects.set(photoKey(to, photoId, kind), { ...obj });
    }
  }

  async remove(photoId: string, area: PhotoArea) {
    for (const kind of KINDS) this.objects.delete(photoKey(area, photoId, kind));
  }

  async invalidate(photoId: string) {
    this.invalidated.push(photoId);
  }
}
