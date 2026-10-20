import { handle, type LambdaContext, type LambdaEvent } from "hono/aws-lambda";
import { createApp } from "./app.js";
import { createPhotoStorage, createRepository, getParameter, requireEnv } from "./aws.js";
import { CloudFrontSigner } from "./url-signer.js";

let app: ReturnType<typeof handle> | undefined;

/** コールドスタート時に一度だけ秘密情報を取得してアプリを組み立てる */
async function init(): Promise<ReturnType<typeof handle>> {
  const [sessionSecret, cloudfrontPrivateKey] = await Promise.all([
    getParameter(requireEnv("SESSION_SECRET_PARAM"), true),
    getParameter(requireEnv("CLOUDFRONT_PRIVATE_KEY_PARAM"), true),
  ]);
  const hono = createApp({
    repo: createRepository(),
    storage: createPhotoStorage(),
    signer: new CloudFrontSigner(requireEnv("CLOUDFRONT_KEY_PAIR_ID"), cloudfrontPrivateKey),
    sessionSecret,
    adminPassword: requireEnv("ADMIN_PASSWORD"),
    secureCookies: true,
  });
  return handle(hono);
}

export const handler = async (event: LambdaEvent, context: LambdaContext) => {
  app ??= await init();
  return app(event, context);
};
