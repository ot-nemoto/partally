import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { MemoryRepository } from "./memory-repository.js";
import { MemoryPhotoStorage } from "./memory-storage.js";
import { ADMIN_PASSWORD, testSigner } from "./test-support.js";

const appWith = (originVerifySecret?: string) =>
  createApp({
    repo: new MemoryRepository(),
    storage: new MemoryPhotoStorage(),
    signer: testSigner,
    sessionSecret: "test-secret",
    adminPassword: ADMIN_PASSWORD,
    secureCookies: true,
    originVerifySecret,
  });

const login = (app: ReturnType<typeof createApp>, headers: Record<string, string> = {}) =>
  app.request("/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });

describe("CloudFront を通ったリクエストだけを受ける（X-Origin-Verify）", () => {
  it("ヘッダが無い・違うリクエストは、処理する前に 403 で断る", async () => {
    const app = appWith("origin-secret");
    const cases: Record<string, string>[] = [{}, { "x-origin-verify": "wrong" }, { "x-origin-verify": "" }];
    for (const headers of cases) {
      const res = await login(app, headers);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect((await app.request("/api/me")).status).toBe(403);
  });

  it("正しいヘッダなら、これまでどおり処理する", async () => {
    const app = appWith("origin-secret");
    expect((await login(app, { "x-origin-verify": "origin-secret" })).status).toBe(200);
    expect((await app.request("/api/me", { headers: { "x-origin-verify": "origin-secret" } })).status).toBe(401);
  });

  it("値を渡さなければ確かめない（ローカル開発・テスト）", async () => {
    expect((await login(appWith())).status).toBe(200);
  });
});
