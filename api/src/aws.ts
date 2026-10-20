import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoRepository } from "./dynamo-repository.js";
import { S3PhotoStorage } from "./photo-storage.js";

const ssm = new SSMClient({});

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`環境変数 ${name} が設定されていません`);
  return value;
}

export async function getParameter(name: string, withDecryption = false): Promise<string> {
  const { Parameter } = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: withDecryption }));
  if (!Parameter?.Value) throw new Error(`SSM パラメータ ${name} が空です`);
  return Parameter.Value;
}

export function createRepository(): DynamoRepository {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return new DynamoRepository(client, requireEnv("TABLE_NAME"));
}

export function createPhotoStorage(): S3PhotoStorage {
  return new S3PhotoStorage(new S3Client({}), requireEnv("PHOTO_BUCKET"), requireEnv("DISTRIBUTION_ID"));
}
