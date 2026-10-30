import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import { CopyObjectCommand, DeleteObjectsCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
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

  it("受け口から配信する領域へ、使うたびに確かめる Cache-Control で移す", async () => {
    s3.on(HeadObjectCommand).resolves({ Metadata: {} });
    expect(await storage.attachPrizeImage("I1")).toBe(true);
    expect(s3.commandCalls(CopyObjectCommand)[0]!.args[0].input).toMatchObject({
      CopySource: "bucket/uploads/prizes/I1.jpg",
      Key: "prizes/I1.jpg",
      CacheControl: "no-cache",
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
