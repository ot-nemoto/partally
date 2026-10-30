import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import { CopyObjectCommand, DeleteObjectsCommand, HeadObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import {
  PHOTO_FULL_MAX_BYTES,
  PHOTO_THUMB_MAX_BYTES,
  PRIZE_IMAGE_MAX_BYTES,
  type PresignedPost,
} from "@partally/shared";

/**
 * - uploads: 参加者が署名付き POST で書き込む受け口。配信しない。取り込み後に消し、残りもライフサイクルで消える
 * - pending: 検閲待ち。サーバだけが書き込むので、検閲後に参加者が中身を差し替えることはできない
 * - approved: 公開済み
 */
export type PhotoArea = "uploads" | "pending" | "approved";
export type PhotoKind = "full" | "thumb";

const KINDS: PhotoKind[] = ["full", "thumb"];
const MAX_BYTES: Record<PhotoKind, number> = { full: PHOTO_FULL_MAX_BYTES, thumb: PHOTO_THUMB_MAX_BYTES };
export const UPLOAD_EXPIRES_SECONDS = 300;
/** 公開済み写真のブラウザ・CloudFront キャッシュ時間。削除後もこの時間はブラウザに残り得る */
const APPROVED_CACHE_CONTROL = "max-age=3600";
/** 景品の画像は差し替えると ID ごと変わるので、同じ URL の中身は変わらない */
const PRIZE_CACHE_CONTROL = "max-age=86400";

/** S3 のキー。配信する領域は CloudFront のパス（/photos/...）と一致させ、パスの書き換えを不要にする */
export function photoKey(area: PhotoArea, photoId: string, kind: PhotoKind): string {
  return area === "uploads" ? `uploads/${photoId}/${kind}.jpg` : `photos/${area}/${photoId}/${kind}.jpg`;
}

export function photoPath(area: Exclude<PhotoArea, "uploads">, photoId: string, kind: PhotoKind): string {
  return `/${photoKey(area, photoId, kind)}`;
}

export function parsePhotoKey(key: string): { area: PhotoArea; photoId: string; kind: PhotoKind } | undefined {
  const m = /^(?:(uploads)|photos\/(pending|approved))\/([0-9A-Za-z]+)\/(full|thumb)\.jpg$/.exec(key);
  if (!m) return undefined;
  return { area: (m[1] ?? m[2]) as PhotoArea, photoId: m[3]!, kind: m[4] as PhotoKind };
}

/**
 * 景品の画像のキー。管理者が署名付き POST で直接置く（参加者の写真のような取り込み処理は通さない）。
 * CloudFront の /prizes/* から署名付き URL で配信する
 */
export function prizeImageKey(imageId: string): string {
  return `prizes/${imageId}.jpg`;
}

export function prizeImagePath(imageId: string): string {
  return `/${prizeImageKey(imageId)}`;
}

export interface PhotoStorage {
  /** 本体・サムネイルを uploads 領域へ直接アップロードするための署名付き POST を発行する */
  createUploads(photoId: string, uploaderId: string): Promise<Record<PhotoKind, PresignedPost>>;
  /** オブジェクトのアップロード者（メタデータ）。オブジェクトが無ければ undefined */
  getUploader(key: string): Promise<string | undefined>;
  /** 本体・サムネイルを別の領域へコピーする（コピー元は残す） */
  copy(photoId: string, from: PhotoArea, to: Exclude<PhotoArea, "uploads">): Promise<void>;
  remove(photoId: string, area: PhotoArea): Promise<void>;
  /** CDN に残っている公開済み写真のキャッシュを消す */
  invalidate(photoId: string): Promise<void>;

  /** 景品の画像を直接アップロードするための署名付き POST を発行する */
  createPrizeImageUpload(imageId: string): Promise<PresignedPost>;
  /** 景品の画像がアップロード済みか */
  hasPrizeImage(imageId: string): Promise<boolean>;
  removePrizeImage(imageId: string): Promise<void>;
}

export class S3PhotoStorage implements PhotoStorage {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly distributionId: string,
    private readonly cloudfront = new CloudFrontClient({}),
  ) {}

  async createUploads(photoId: string, uploaderId: string) {
    const entries = await Promise.all(
      KINDS.map(async (kind) => {
        const { url, fields } = await createPresignedPost(this.s3, {
          Bucket: this.bucket,
          Key: photoKey("uploads", photoId, kind),
          Fields: { "Content-Type": "image/jpeg", "x-amz-meta-uploader": uploaderId },
          Conditions: [
            ["content-length-range", 1, MAX_BYTES[kind]],
            ["eq", "$Content-Type", "image/jpeg"],
            ["eq", "$x-amz-meta-uploader", uploaderId],
          ],
          Expires: UPLOAD_EXPIRES_SECONDS,
        });
        return [kind, { url, fields }] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<PhotoKind, PresignedPost>;
  }

  async getUploader(key: string) {
    try {
      const head = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return head.Metadata?.uploader ?? "";
    } catch (e) {
      if (e instanceof Error && (e.name === "NotFound" || e.name === "NoSuchKey")) return undefined;
      throw e;
    }
  }

  async copy(photoId: string, from: PhotoArea, to: Exclude<PhotoArea, "uploads">) {
    await Promise.all(
      KINDS.map((kind) =>
        this.s3.send(
          new CopyObjectCommand({
            Bucket: this.bucket,
            CopySource: `${this.bucket}/${photoKey(from, photoId, kind)}`,
            Key: photoKey(to, photoId, kind),
            MetadataDirective: "REPLACE",
            ContentType: "image/jpeg",
            CacheControl: to === "approved" ? APPROVED_CACHE_CONTROL : undefined,
          }),
        ),
      ),
    );
  }

  async remove(photoId: string, area: PhotoArea) {
    await this.s3.send(
      new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: KINDS.map((kind) => ({ Key: photoKey(area, photoId, kind) })), Quiet: true },
      }),
    );
  }

  async createPrizeImageUpload(imageId: string) {
    const { url, fields } = await createPresignedPost(this.s3, {
      Bucket: this.bucket,
      Key: prizeImageKey(imageId),
      Fields: { "Content-Type": "image/jpeg", "Cache-Control": PRIZE_CACHE_CONTROL },
      Conditions: [
        ["content-length-range", 1, PRIZE_IMAGE_MAX_BYTES],
        ["eq", "$Content-Type", "image/jpeg"],
        ["eq", "$Cache-Control", PRIZE_CACHE_CONTROL],
      ],
      Expires: UPLOAD_EXPIRES_SECONDS,
    });
    return { url, fields };
  }

  async hasPrizeImage(imageId: string) {
    return (await this.getUploader(prizeImageKey(imageId))) !== undefined;
  }

  async removePrizeImage(imageId: string) {
    await this.s3.send(
      new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: [{ Key: prizeImageKey(imageId) }], Quiet: true },
      }),
    );
  }

  async invalidate(photoId: string) {
    await this.cloudfront.send(
      new CreateInvalidationCommand({
        DistributionId: this.distributionId,
        InvalidationBatch: {
          CallerReference: `${photoId}-${Date.now()}`,
          Paths: { Quantity: 1, Items: [`/photos/approved/${photoId}/*`] },
        },
      }),
    );
  }
}
