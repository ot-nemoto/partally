import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  S3Client,
} from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { S3PhotoStorage } from "./photo-storage.js";

const s3 = mockClient(S3Client);
const cloudfront = mockClient(CloudFrontClient);
const storage = new S3PhotoStorage(new S3Client({}), "bucket", "DIST", new CloudFrontClient({}));

describe("S3PhotoStorage（景品の画像）", () => {
  beforeEach(() => {
    s3.reset();
    cloudfront.reset();
  });

  it("受け口から配信する領域へ、ブラウザは使うたびに確かめ CloudFront には残す Cache-Control で移す", async () => {
    s3.on(HeadObjectCommand).resolves({ Metadata: {} });
    expect(await storage.attachPrizeImage("I1")).toBe(true);
    expect(s3.commandCalls(CopyObjectCommand)[0]!.args[0].input).toMatchObject({
      CopySource: "bucket/uploads/prizes/I1.jpg",
      Key: "prizes/I1.jpg",
      CacheControl: "max-age=0, must-revalidate, s-maxage=86400",
    });
    expect(s3.commandCalls(DeleteObjectsCommand)[0]!.args[0].input.Delete?.Objects).toEqual([
      { Key: "uploads/prizes/I1.jpg" },
    ]);
  });

  it("消すときは CloudFront のキャッシュも無効化する", async () => {
    s3.on(DeleteObjectsCommand).resolves({});
    cloudfront.on(CreateInvalidationCommand).resolves({});
    await storage.removePrizeImage("I1");
    expect(s3.commandCalls(DeleteObjectsCommand)[0]!.args[0].input.Delete?.Objects).toEqual([{ Key: "prizes/I1.jpg" }]);
    expect(cloudfront.commandCalls(CreateInvalidationCommand)[0]!.args[0].input).toMatchObject({
      DistributionId: "DIST",
      InvalidationBatch: { Paths: { Quantity: 1, Items: ["/prizes/I1.jpg"] } },
    });
  });
});

describe("S3PhotoStorage（写真の形式）", () => {
  beforeEach(() => s3.reset());

  // S3 の応答の本文のうち、使うところ（バイト列への変換）だけを持つもの
  const body = (bytes: number[]): any => ({ transformToByteArray: async () => new Uint8Array(bytes) });

  it("先頭の 3 バイトだけを読み、JPEG の形式（FF D8 FF）かを返す", async () => {
    s3.on(GetObjectCommand)
      .resolvesOnce({ Body: body([0xff, 0xd8, 0xff]) })
      .resolvesOnce({ Body: body([0x3c, 0x68, 0x74]) });
    expect(await storage.isJpeg("uploads/P1/full.jpg")).toBe(true);
    expect(await storage.isJpeg("uploads/P2/full.jpg")).toBe(false);
    expect(s3.commandCalls(GetObjectCommand)[0]!.args[0].input).toEqual({
      Bucket: "bucket",
      Key: "uploads/P1/full.jpg",
      Range: "bytes=0-2",
    });
  });

  it("オブジェクトが無ければ false", async () => {
    s3.on(GetObjectCommand).rejects(new NoSuchKey({ message: "missing", $metadata: {} }));
    expect(await storage.isJpeg("uploads/P1/full.jpg")).toBe(false);
  });
});
