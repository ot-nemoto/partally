// CloudFront から API へのリクエストに付ける秘密の値（X-Origin-Verify）を作るカスタムリソース。
// 値は SSM SecureString に保存し、一度作ったら使い回す（デプロイのたびに変わると、CloudFront の設定の反映を待つ間に API が断ってしまう）。
// CloudFront のオリジンのカスタムヘッダに入れるため、値は CloudFormation に返すが、NoEcho でスタックの表示には出さない
import { randomBytes } from "node:crypto";
import {
  DeleteParameterCommand,
  GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import type { CloudFormationCustomResourceEvent } from "aws-lambda";

const ssm = new SSMClient({});

export const handler = async (event: CloudFormationCustomResourceEvent) => {
  const parameterName = event.ResourceProperties.ParameterName as string;

  if (event.RequestType === "Delete") {
    await ssm.send(new DeleteParameterCommand({ Name: parameterName })).catch((e) => {
      if (!(e instanceof ParameterNotFound)) throw e;
    });
    return { PhysicalResourceId: event.PhysicalResourceId };
  }

  let secret = await getSecret(parameterName);
  if (!secret) {
    secret = randomBytes(32).toString("base64url");
    await ssm.send(
      new PutParameterCommand({
        Name: parameterName,
        Type: "SecureString",
        Value: secret,
        Description: "partally: CloudFront から API へのリクエストに付ける秘密の値（カスタムリソースが管理）",
      }),
    );
  }
  return { PhysicalResourceId: parameterName, NoEcho: true, Data: { Secret: secret } };
};

async function getSecret(name: string): Promise<string | undefined> {
  try {
    const { Parameter } = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    return Parameter?.Value;
  } catch (e) {
    if (e instanceof ParameterNotFound) return undefined;
    throw e;
  }
}
