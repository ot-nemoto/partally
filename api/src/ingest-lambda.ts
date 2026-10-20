import type { S3Event } from "aws-lambda";
import { createPhotoStorage, createRepository } from "./aws.js";
import { ingestUpload } from "./ingest.js";

const deps = { repo: createRepository(), storage: createPhotoStorage() };

/** photos バケットの pending/*\/full.jpg 作成イベントで呼ばれる */
export const handler = async (event: S3Event) => {
  for (const record of event.Records) {
    // S3 イベントのキーは URL エンコードされ、空白は + になっている
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    const result = await ingestUpload(deps, key);
    console.log(JSON.stringify({ key, result }));
  }
};
