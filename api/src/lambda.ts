import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handle, type LambdaContext, type LambdaEvent } from "hono/aws-lambda";
import { createApp } from "./app.js";
import { DynamoRepository } from "./dynamo-repository.js";

let app: ReturnType<typeof handle> | undefined;

/** コールドスタート時に一度だけ秘密情報を取得してアプリを組み立てる */
async function init(): Promise<ReturnType<typeof handle>> {
  const tableName = requireEnv("TABLE_NAME");
  const adminPassword = requireEnv("ADMIN_PASSWORD");
  const sessionSecretParam = requireEnv("SESSION_SECRET_PARAM");

  const ssm = new SSMClient({});
  const { Parameter } = await ssm.send(
    new GetParameterCommand({ Name: sessionSecretParam, WithDecryption: true }),
  );
  if (!Parameter?.Value) throw new Error(`SSM パラメータ ${sessionSecretParam} が空です`);

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const hono = createApp({
    repo: new DynamoRepository(client, tableName),
    sessionSecret: Parameter.Value,
    adminPassword,
    secureCookies: true,
  });
  return handle(hono);
}

export const handler = async (event: LambdaEvent, context: LambdaContext) => {
  app ??= await init();
  return app(event, context);
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`環境変数 ${name} が設定されていません`);
  return value;
}
