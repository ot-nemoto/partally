// ローカル開発用サーバ。DynamoDB・S3 の代わりにメモリ上のリポジトリ・ストレージを使う（再起動でデータは消える）
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createApp } from "./app.js";
import { ingestUpload } from "./ingest.js";
import { MemoryRepository } from "./memory-repository.js";
import { MemoryPhotoStorage } from "./memory-storage.js";
import { NoopSigner } from "./url-signer.js";

const port = Number(process.env.PORT ?? 8787);
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const adminPassword = process.env.ADMIN_PASSWORD ?? "admin";

const repo = new MemoryRepository();
const storage = new MemoryPhotoStorage();
const tokens = await repo.createTokens(
  Array.from({ length: 5 }, () => crypto.getRandomValues(new Uint8Array(16))).map((b) =>
    Buffer.from(b).toString("base64url"),
  ),
  new Date().toISOString(),
);

const api = createApp({
  repo,
  storage,
  signer: new NoopSigner(),
  sessionSecret: "local-dev-secret",
  adminPassword,
  secureCookies: false,
});

const root = new Hono();

// S3 の署名付き POST の代わり。本体が届いたら S3 イベントの代わりに取り込み処理を呼ぶ
root.post("/__dev/upload", async (c) => {
  const form = await c.req.formData();
  const key = String(form.get("key"));
  const file = form.get("file");
  if (!(file instanceof File)) return c.text("file がありません", 400);
  storage.put(key, new Uint8Array(await file.arrayBuffer()), String(form.get("x-amz-meta-uploader")));
  if (key.endsWith("/full.jpg")) console.log(`取り込み: ${key} → ${await ingestUpload({ repo, storage }, key)}`);
  return c.body(null, 204);
});

// CloudFront の代わりに写真を配信する（ローカルでは署名を確認しない）
root.get("/photos/*", (c) => {
  const data = storage.get(c.req.path.slice(1));
  if (!data) return c.text("not found", 404);
  return c.body(data, 200, { "content-type": "image/jpeg" });
});

root.route("/", api);

serve({ fetch: root.fetch, port }, () => {
  console.log(`API: http://localhost:${port}/api`);
  console.log(`管理画面: ${webOrigin}/admin （パスワード: ${adminPassword}）`);
  console.log("お試し用 QR URL:");
  for (const t of tokens) console.log(`  ${t.label}: ${webOrigin}/q/${t.token}`);
});
