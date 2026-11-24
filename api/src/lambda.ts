import { handle, type LambdaContext, type LambdaEvent } from "hono/aws-lambda";
import { type AppDeps, createApp } from "./app.js";
import { createPhotoStorage, createRepository, getParameter, requireEnv } from "./aws.js";
import { cachedValue } from "./cached-value.js";
import { CloudFrontSigner } from "./url-signer.js";

/**
 * 管理者パスワードを SSM から読み直す間。デプロイの CI がパスワードを書き換えたとき、
 * 温まっている Lambda もこの間のうちに新しいパスワードに切り替わる（古いパスワードの管理者の Cookie も使えなくなる）
 */
const ADMIN_PASSWORD_REFRESH_MS = 5 * 60 * 1000;

const adminPassword = cachedValue(
  () => getParameter(requireEnv("ADMIN_PASSWORD_PARAM"), true),
  ADMIN_PASSWORD_REFRESH_MS,
);

let deps: Omit<AppDeps, "adminPassword"> | undefined;
let app: { adminPassword: string; handler: ReturnType<typeof handle> } | undefined;

/** コールドスタート時に一度だけ秘密情報を取得して、アプリの部品を組み立てる */
async function init(): Promise<Omit<AppDeps, "adminPassword">> {
  const [sessionSecret, cloudfrontPrivateKey, originVerifySecret] = await Promise.all([
    getParameter(requireEnv("SESSION_SECRET_PARAM"), true),
    getParameter(requireEnv("CLOUDFRONT_PRIVATE_KEY_PARAM"), true),
    getParameter(requireEnv("ORIGIN_VERIFY_PARAM"), true),
  ]);
  return {
    repo: createRepository(),
    storage: createPhotoStorage(),
    signer: new CloudFrontSigner(requireEnv("CLOUDFRONT_KEY_PAIR_ID"), cloudfrontPrivateKey),
    sessionSecret,
    secureCookies: true,
    originVerifySecret,
  };
}

export const handler = async (event: LambdaEvent, context: LambdaContext) => {
  deps ??= await init();
  // 管理者パスワードが変わっていたら、アプリを作り直す（管理者の Cookie の署名鍵もパスワードから作るため）
  const password = await adminPassword();
  if (app?.adminPassword !== password) {
    app = { adminPassword: password, handler: handle(createApp({ ...deps, adminPassword: password })) };
  }
  return app.handler(event, context);
};
