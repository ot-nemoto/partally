import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { PHOTO_FULL_MAX_BYTES, PHOTO_THUMB_MAX_BYTES, type PresignedPost } from "@partally/shared";

export type PhotoArea = "pending" | "approved";
export type PhotoKind = "full" | "thumb";

const KINDS: PhotoKind[] = ["full", "thumb"];
const MAX_BYTES: Record<PhotoKind, number> = { full: PHOTO_FULL_MAX_BYTES, thumb: PHOTO_THUMB_MAX_BYTES };
const UPLOAD_EXPIRES_SECONDS = 300;
/** 公開済み写真のブラウザ・CloudFront キャッシュ時間。削除後もこの時間はブラウザに残り得る */
const APPROVED_CACHE_CONTROL = "max-age=3600";

/** S3 のキー。CloudFront のパス（/photos/...）と一致させ、パスの書き換えを不要にする */
export function photoKey(area: PhotoArea, photoId: string, kind: PhotoKind): string {
  return `photos/${area}/${photoId}/${kind}.jpg`;
}

export function photoPath(area: PhotoArea, photoId: string, kind: PhotoKind): string {
  return `/${photoKey(area, photoId, kind)}`;
}

export function parsePhotoKey(key: string): { area: PhotoArea; photoId: string; kind: PhotoKind } | undefined {
  const m = /^photos\/(pending|approved)\/([0-9A-Za-z]+)\/(full|thumb)\.jpg$/.exec(key);
  if (!m) return undefined;
  return { area: m[1] as PhotoArea, photoId: m[2]!, kind: m[3] as PhotoKind };
}

export interface PhotoStorage {
  /** 本体・サムネイルを pending 領域へ直接アップロードするための署名付き POST を発行する */
  createUploads(photoId: string, uploaderId: string): Promise<Record<PhotoKind, PresignedPost>>;
  /** オブジェクトのアップロード者（メタデータ）。オブジェクトが無ければ undefined */
  getUploader(key: string): Promise<string | undefined>;
  /** pending の本体・サムネイルを approved へコピーする（pending は残す） */
  copyToApproved(photoId: string): Promise<void>;
  remove(photoId: string, area: PhotoArea): Promise<void>;
  /** CDN に残っている公開済み写真のキャッシュを消す */
  invalidate(photoId: string): Promise<void>;
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
          Key: photoKey("pending", photoId, kind),
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

  async copyToApproved(photoId: string) {
    await Promise.all(
      KINDS.map((kind) =>
        this.s3.send(
          new CopyObjectCommand({
            Bucket: this.bucket,
            CopySource: `${this.bucket}/${photoKey("pending", photoId, kind)}`,
            Key: photoKey("approved", photoId, kind),
            MetadataDirective: "REPLACE",
            ContentType: "image/jpeg",
            CacheControl: APPROVED_CACHE_CONTROL,
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
