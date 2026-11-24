import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createRepository, requireEnv } from "./aws.js";
import { resetAll, UNLOCK_ADMIN_LOGIN_ACTION } from "./reset.js";

/**
 * GitHub Actions から呼ばれる。
 * - Reset ワークフロー：`{"confirm": "..."}` で本番データをすべて消す
 * - Unlock admin login ワークフロー：`{"action": "unlock-admin-login"}` で管理者のログインの制限を解除する
 */
export const handler = async (event: { confirm?: unknown; action?: unknown }) => {
  if (event?.action === UNLOCK_ADMIN_LOGIN_ACTION) {
    const cleared = await createRepository().clearAdminLoginAttempts();
    console.log(JSON.stringify({ unlockAdminLogin: { cleared } }));
    return { cleared };
  }
  const result = await resetAll(
    {
      ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      tableName: requireEnv("TABLE_NAME"),
      s3: new S3Client({}),
      bucket: requireEnv("PHOTO_BUCKET"),
      cloudfront: new CloudFrontClient({}),
      distributionId: requireEnv("DISTRIBUTION_ID"),
    },
    event?.confirm,
  );
  console.log(JSON.stringify({ reset: result }));
  return result;
};
