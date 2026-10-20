// CloudFront の署名付き Cookie / URL 用の鍵ペアを作るカスタムリソース。
// 秘密鍵は SSM SecureString に保存し、公開鍵だけを CloudFormation に返す（テンプレートに秘密鍵を残さない）。
import { createPublicKey, generateKeyPairSync } from "node:crypto";
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

  // 既に鍵があれば使い回す（更新時やスタック再作成時に鍵が変わって全員の Cookie が無効になるのを避ける）
  let privateKeyPem = await getPrivateKey(parameterName);
  if (!privateKeyPem) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await ssm.send(
      new PutParameterCommand({
        Name: parameterName,
        Type: "SecureString",
        Value: privateKeyPem,
        Description: "partally: CloudFront 署名用の秘密鍵（カスタムリソースが管理）",
      }),
    );
  }
  const publicKeyPem = createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString();
  return { PhysicalResourceId: parameterName, Data: { PublicKey: publicKeyPem } };
};

async function getPrivateKey(name: string): Promise<string | undefined> {
  try {
    const { Parameter } = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    return Parameter?.Value;
  } catch (e) {
    if (e instanceof ParameterNotFound) return undefined;
    throw e;
  }
}
