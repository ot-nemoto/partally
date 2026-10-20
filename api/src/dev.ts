// ローカル開発用サーバ。DynamoDB の代わりにメモリ上のリポジトリを使う（再起動でデータは消える）
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { MemoryRepository } from "./memory-repository.js";

const port = Number(process.env.PORT ?? 8787);
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const adminPassword = process.env.ADMIN_PASSWORD ?? "admin";

const repo = new MemoryRepository();
const tokens = await repo.createTokens(
  Array.from({ length: 5 }, () => crypto.getRandomValues(new Uint8Array(16))).map((b) =>
    Buffer.from(b).toString("base64url"),
  ),
  new Date().toISOString(),
);

const app = createApp({
  repo,
  sessionSecret: "local-dev-secret",
  adminPassword,
  secureCookies: false,
});

serve({ fetch: app.fetch, port }, () => {
  console.log(`API: http://localhost:${port}/api`);
  console.log(`管理画面: ${webOrigin}/admin （パスワード: ${adminPassword}）`);
  console.log("お試し用 QR URL:");
  for (const t of tokens) console.log(`  ${t.label}: ${webOrigin}/q/${t.token}`);
});
