import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { requireEnv } from "./aws.js";
import { resetAll } from "./reset.js";

/** GitHub Actions の Reset ワークフローから `{"confirm": "..."}` で呼ばれる */
export const handler = async (event: { confirm?: unknown }) => {
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
