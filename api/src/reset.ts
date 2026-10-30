import { type CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import {
  BatchWriteCommand,
  type BatchWriteCommandInput,
  type BatchWriteCommandOutput,
  type DynamoDBDocumentClient,
  ScanCommand,
  type ScanCommandOutput,
} from "@aws-sdk/lib-dynamodb";

/** 初期化 Lambda の呼び出しに必ず含める値。誤った呼び出しで消さないための合言葉 */
export const RESET_CONFIRMATION = "delete-all-partally-data";

export interface ResetDeps {
  ddb: DynamoDBDocumentClient;
  tableName: string;
  s3: S3Client;
  bucket: string;
  cloudfront: CloudFrontClient;
  distributionId: string;
}

export interface ResetResult {
  /** 削除した DynamoDB のアイテム数 */
  items: number;
  /** 削除した写真バケットのオブジェクト数 */
  objects: number;
}

const BATCH_WRITE_MAX = 25;
/** 消している間に API や取り込みが書いたアイテムも消すため、空になるまで数回スキャンし直す */
const MAX_PASSES = 3;

/**
 * 本番データをすべて消して、デプロイ直後の状態に戻す（参加者・QR・写真・お気に入り・クイズ・景品・設定）。
 * SSM の鍵とインフラは残す。GitHub Actions の Reset ワークフローから呼ぶ
 */
export async function resetAll(deps: ResetDeps, confirmation: unknown): Promise<ResetResult> {
  if (confirmation !== RESET_CONFIRMATION) throw new Error("確認用の値が違うため、初期化しませんでした");
  try {
    // 写真を先に消す。途中で失敗しても、もう一度実行すれば残りを消せる（何度実行しても同じ結果になる）
    const objects = await deleteAllObjects(deps);
    let items = 0;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const deleted = await deleteAllItems(deps);
      items += deleted;
      if (deleted === 0) break;
    }
    return { items, objects };
  } finally {
    // 途中で失敗しても、署名付き Cookie を持つ人が消した写真をキャッシュから見られないようにする
    await deps.cloudfront.send(
      new CreateInvalidationCommand({
        DistributionId: deps.distributionId,
        InvalidationBatch: {
          CallerReference: `reset-${Date.now()}`,
          Paths: { Quantity: 2, Items: ["/photos/*", "/prizes/*"] },
        },
      }),
    );
  }
}

async function deleteAllItems(deps: ResetDeps): Promise<number> {
  let count = 0;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page: ScanCommandOutput = await deps.ddb.send(
      new ScanCommand({
        TableName: deps.tableName,
        ProjectionExpression: "PK, SK",
        ConsistentRead: true,
        ExclusiveStartKey,
      }),
    );
    const keys = (page.Items ?? []).map((item) => ({ PK: item.PK, SK: item.SK }));
    for (let i = 0; i < keys.length; i += BATCH_WRITE_MAX) {
      await batchDelete(deps, keys.slice(i, i + BATCH_WRITE_MAX));
    }
    count += keys.length;
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return count;
}

/** 未処理分は数回まで再送する */
async function batchDelete(deps: ResetDeps, keys: Record<string, unknown>[]) {
  let requests: NonNullable<BatchWriteCommandInput["RequestItems"]>[string] | undefined = keys.map((Key) => ({
    DeleteRequest: { Key },
  }));
  for (let attempt = 0; requests && requests.length > 0; attempt++) {
    if (attempt >= 5) throw new Error("BatchWrite が未処理のまま残りました");
    const { UnprocessedItems }: BatchWriteCommandOutput = await deps.ddb.send(
      new BatchWriteCommand({ RequestItems: { [deps.tableName]: requests } }),
    );
    requests = UnprocessedItems?.[deps.tableName];
    if (requests?.length) await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
  }
}

async function deleteAllObjects(deps: ResetDeps): Promise<number> {
  let count = 0;
  let ContinuationToken: string | undefined;
  do {
    const page = await deps.s3.send(new ListObjectsV2Command({ Bucket: deps.bucket, ContinuationToken }));
    const objects = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
    if (objects.length > 0) {
      const res = await deps.s3.send(
        new DeleteObjectsCommand({ Bucket: deps.bucket, Delete: { Objects: objects, Quiet: true } }),
      );
      if (res.Errors?.length) throw new Error(`写真の削除に失敗しました: ${res.Errors[0]?.Key} ${res.Errors[0]?.Code}`);
    }
    count += objects.length;
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return count;
}
