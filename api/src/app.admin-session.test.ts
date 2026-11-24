import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { MemoryRepository } from "./memory-repository.js";
import { MemoryPhotoStorage } from "./memory-storage.js";
import { adminSessionKey } from "./session.js";
import { ADMIN_PASSWORD, testSigner } from "./test-support.js";

const SESSION_SECRET = "test-secret";

describe("管理者パスワードを変えたときの管理者のログイン", () => {
  let repo: MemoryRepository;
  const appWith = (adminPassword: string) =>
    createApp({
      repo,
      storage: new MemoryPhotoStorage(),
      signer: testSigner,
      sessionSecret: SESSION_SECRET,
      adminPassword,
      secureCookies: true,
    });

  beforeEach(() => {
    repo = new MemoryRepository();
  });

  /** Set-Cookie から「名前=値」だけを取り出す */
  const cookieOf = (res: Response, name: string) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .find((c) => c.startsWith(`${name}=`))!;

  const post = (app: ReturnType<typeof createApp>, path: string, body: unknown, cookie?: string) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  const adminCookie = async (app: ReturnType<typeof createApp>, password: string) =>
    cookieOf(await post(app, "/api/admin/login", { password }), "admin_session");

  it("パスワードが同じなら、発行済みの管理者の Cookie はそのまま使える（デプロイし直しても切れない）", async () => {
    const cookie = await adminCookie(appWith(ADMIN_PASSWORD), ADMIN_PASSWORD);
    expect((await appWith(ADMIN_PASSWORD).request("/api/admin/me", { headers: { cookie } })).status).toBe(200);
  });

  it("パスワードを変えると、それまでの管理者の Cookie は使えない（新しいパスワードでログインし直す）", async () => {
    const cookie = await adminCookie(appWith(ADMIN_PASSWORD), ADMIN_PASSWORD);
    const changed = appWith("new-password");
    expect((await changed.request("/api/admin/me", { headers: { cookie } })).status).toBe(401);
    const renewed = await adminCookie(changed, "new-password");
    expect((await changed.request("/api/admin/me", { headers: { cookie: renewed } })).status).toBe(200);
  });

  it("参加者の Cookie は、管理者パスワードを変えても使える", async () => {
    const before = appWith(ADMIN_PASSWORD);
    const admin = await adminCookie(before, ADMIN_PASSWORD);
    const issued = await post(before, "/api/admin/tokens", { count: 1 }, admin);
    const { tokens } = (await issued.json()) as { tokens: { token: string }[] };
    const registered = await post(before, "/api/auth/register", { token: tokens[0]!.token, name: "田中", pin: "1234" });
    expect(registered.status).toBe(201);
    const user = cookieOf(registered, "session");
    expect((await appWith("new-password").request("/api/me", { headers: { cookie: user } })).status).toBe(200);
  });

  it("管理者の署名鍵は、パスワードごとに違い、参加者の署名鍵（セッションの鍵）とも違う", () => {
    const a = adminSessionKey(SESSION_SECRET, "a");
    expect(a).not.toBe(adminSessionKey(SESSION_SECRET, "b"));
    expect(a).not.toBe(SESSION_SECRET);
    expect(a).toBe(adminSessionKey(SESSION_SECRET, "a"));
  });
});
