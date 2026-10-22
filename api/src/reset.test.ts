import { readFileSync } from "node:fs";
import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { BatchWriteCommand, DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { RESET_CONFIRMATION, resetAll } from "./reset.js";

const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);
const cloudfront = mockClient(CloudFrontClient);
const deps = {
  ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
  tableName: "table",
  s3: new S3Client({}),
  bucket: "photos",
  cloudfront: new CloudFrontClient({}),
  distributionId: "DIST",
};

const item = (i: number) => ({ PK: `USER#u${i}`, SK: "PROFILE" });

describe("resetAll", () => {
  beforeEach(() => {
    ddb.reset();
    s3.reset();
    cloudfront.reset();
    ddb.on(BatchWriteCommand).resolves({});
    s3.on(DeleteObjectsCommand).resolves({});
    cloudfront.on(CreateInvalidationCommand).resolves({});
  });

  it("テーブルの全アイテムを 25 件ずつ消し、バケットの全オブジェクトを消して写真のキャッシュを無効化する", async () => {
    ddb
      .on(ScanCommand)
      .resolvesOnce({ Items: Array.from({ length: 30 }, (_, i) => item(i)), LastEvaluatedKey: item(29) })
      .resolvesOnce({ Items: [item(30)] })
      .resolves({ Items: [] });
    s3.on(ListObjectsV2Command)
      .resolvesOnce({
        Contents: [{ Key: "photos/approved/P1/full.jpg" }, { Key: "photos/approved/P1/thumb.jpg" }],
        IsTruncated: true,
        NextContinuationToken: "next",
      })
      .resolvesOnce({ Contents: [{ Key: "uploads/P2/full.jpg" }], IsTruncated: false });

    expect(await resetAll(deps, RESET_CONFIRMATION)).toEqual({ items: 31, objects: 3 });

    const scans = ddb.commandCalls(ScanCommand).map((c) => c.args[0].input);
    expect(scans[0]).toMatchObject({ TableName: "table", ProjectionExpression: "PK, SK", ConsistentRead: true });
    expect(scans[1]!.ExclusiveStartKey).toEqual(item(29));
    const batches = ddb.commandCalls(BatchWriteCommand).map((c) => c.args[0].input.RequestItems!.table!);
    expect(batches.map((b) => b.length)).toEqual([25, 5, 1]);
    expect(batches[0]![0]).toEqual({ DeleteRequest: { Key: item(0) } });

    const lists = s3.commandCalls(ListObjectsV2Command).map((c) => c.args[0].input);
    expect(lists[1]!.ContinuationToken).toBe("next");
    const deletes = s3.commandCalls(DeleteObjectsCommand).map((c) => c.args[0].input.Delete!.Objects!.length);
    expect(deletes).toEqual([2, 1]);

    expect(cloudfront.commandCalls(CreateInvalidationCommand)[0]!.args[0].input).toMatchObject({
      DistributionId: "DIST",
      InvalidationBatch: { Paths: { Quantity: 1, Items: ["/photos/*"] } },
    });
  });

  it("消している間に書き込まれたアイテムも、スキャンし直して消す（空になるまで、最大 3 回）", async () => {
    ddb
      .on(ScanCommand)
      .resolvesOnce({ Items: [item(1)] })
      .resolvesOnce({ Items: [item(2)] })
      .resolves({ Items: [] });
    s3.on(ListObjectsV2Command).resolves({ Contents: [] });
    expect(await resetAll(deps, RESET_CONFIRMATION)).toEqual({ items: 2, objects: 0 });
    expect(ddb.commandCalls(ScanCommand)).toHaveLength(3);

    ddb.reset();
    ddb.on(BatchWriteCommand).resolves({});
    ddb.on(ScanCommand).resolves({ Items: [item(9)] });
    await resetAll(deps, RESET_CONFIRMATION);
    expect(ddb.commandCalls(ScanCommand)).toHaveLength(3);
  });

  it("未処理で返ってきたアイテムは再送する", async () => {
    ddb
      .on(ScanCommand)
      .resolvesOnce({ Items: [item(1), item(2)] })
      .resolves({ Items: [] });
    ddb
      .on(BatchWriteCommand)
      .resolvesOnce({ UnprocessedItems: { table: [{ DeleteRequest: { Key: item(2) } }] } })
      .resolves({});
    s3.on(ListObjectsV2Command).resolves({ Contents: [] });
    await resetAll(deps, RESET_CONFIRMATION);
    const batches = ddb.commandCalls(BatchWriteCommand).map((c) => c.args[0].input.RequestItems!.table!.length);
    expect(batches).toEqual([2, 1]);
  });

  it("写真の削除に失敗したらエラーにする。テーブルには触れず、写真のキャッシュは無効化する", async () => {
    s3.on(ListObjectsV2Command).resolves({ Contents: [{ Key: "photos/approved/P1/full.jpg" }] });
    s3.on(DeleteObjectsCommand).resolves({ Errors: [{ Key: "photos/approved/P1/full.jpg", Code: "AccessDenied" }] });
    await expect(resetAll(deps, RESET_CONFIRMATION)).rejects.toThrow("写真の削除に失敗しました");
    expect(ddb.calls()).toHaveLength(0);
    expect(cloudfront.commandCalls(CreateInvalidationCommand)).toHaveLength(1);
  });

  it("Reset ワークフローが送る合言葉はこのモジュールと同じ", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/reset.yml", import.meta.url), "utf8");
    expect(workflow).toContain(`"confirm":"${RESET_CONFIRMATION}"`);
  });

  it("確認用の値が無い・違う呼び出しでは何も消さない", async () => {
    await expect(resetAll(deps, undefined)).rejects.toThrow("初期化しませんでした");
    await expect(resetAll(deps, "yes")).rejects.toThrow("初期化しませんでした");
    expect(ddb.calls()).toHaveLength(0);
    expect(s3.calls()).toHaveLength(0);
    expect(cloudfront.calls()).toHaveLength(0);
  });
});
