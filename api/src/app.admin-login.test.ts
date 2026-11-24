import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_LOGIN_MAX_PER_SOURCE, ADMIN_LOGIN_MAX_TOTAL, ADMIN_LOGIN_WINDOW_MS } from "./admin-login-limit.js";
import { createApp } from "./app.js";
import { MemoryRepository } from "./memory-repository.js";
import { MemoryPhotoStorage } from "./memory-storage.js";
import { ADMIN_PASSWORD, testSigner } from "./test-support.js";

/** 区切りの始まり（15 分の区切りにそろった時刻） */
const WINDOW_START = Date.parse("2026-11-24T10:00:00.000Z");

describe("管理者のログインの試行回数の制限", () => {
  let repo: MemoryRepository;
  let app: ReturnType<typeof createApp>;
  let nowMs: number;

  beforeEach(() => {
    repo = new MemoryRepository();
    nowMs = WINDOW_START + 60_000;
    app = createApp({
      repo,
      storage: new MemoryPhotoStorage(),
      signer: testSigner,
      sessionSecret: "test-secret",
      adminPassword: ADMIN_PASSWORD,
      secureCookies: true,
      now: () => new Date(nowMs),
    });
  });

  /** CloudFront が付ける閲覧者の接続元（`<IP>:<ポート>`）を付けてログインする */
  const login = async (password: string, viewer = "203.0.113.1:50000") => {
    const res = await app.request("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cloudfront-viewer-address": viewer },
      body: JSON.stringify({ password }),
    });
    return {
      status: res.status,
      body: (await res.json()) as { error?: string; message?: string },
      headers: res.headers,
    };
  };

  const failTimes = async (n: number, viewer?: string) => {
    for (let i = 0; i < n; i++) expect((await login("wrong", viewer)).status).toBe(401);
  };

  it("同じ接続元で上限まで間違えると、区切りが終わるまで断る（合っていても断る）。あと何分かを返す", async () => {
    await failTimes(ADMIN_LOGIN_MAX_PER_SOURCE);
    const locked = await login(ADMIN_PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.body).toEqual({ error: "login_locked", message: "あと 14 分" });
    expect(locked.headers.get("retry-after")).toBe(String(14 * 60));
    expect(locked.headers.get("set-cookie")).toBeNull();
  });

  it("ポートが違っても同じ接続元として数える（IPv6 も）", async () => {
    for (let i = 0; i < ADMIN_LOGIN_MAX_PER_SOURCE; i++) await login("wrong", `2001:db8::1:${40000 + i}`);
    expect((await login(ADMIN_PASSWORD, "2001:db8::1:49999")).status).toBe(429);
  });

  it("ほかの接続元からは入れる", async () => {
    await failTimes(ADMIN_LOGIN_MAX_PER_SOURCE);
    expect((await login(ADMIN_PASSWORD, "198.51.100.7:1234")).status).toBe(200);
  });

  it("区切りが変わると、また試せる", async () => {
    await failTimes(ADMIN_LOGIN_MAX_PER_SOURCE);
    nowMs = WINDOW_START + ADMIN_LOGIN_WINDOW_MS;
    expect((await login(ADMIN_PASSWORD)).status).toBe(200);
  });

  it("合っていたら、その接続元の回数を数え直す", async () => {
    await failTimes(ADMIN_LOGIN_MAX_PER_SOURCE - 1);
    expect((await login(ADMIN_PASSWORD)).status).toBe(200);
    await failTimes(ADMIN_LOGIN_MAX_PER_SOURCE - 1);
    expect((await login(ADMIN_PASSWORD)).status).toBe(200);
  });

  it("全体で上限まで間違えると、どの接続元からも断る", async () => {
    const sources = ADMIN_LOGIN_MAX_TOTAL / ADMIN_LOGIN_MAX_PER_SOURCE;
    for (let s = 0; s < sources; s++) await failTimes(ADMIN_LOGIN_MAX_PER_SOURCE, `192.0.2.${s}:1000`);
    expect((await login(ADMIN_PASSWORD, "198.51.100.7:1234")).status).toBe(429);
  });

  it("合ったログインは全体の回数に残さない（間違えた数だけを数える）", async () => {
    for (let i = 0; i < ADMIN_LOGIN_MAX_TOTAL; i++) {
      expect((await login(ADMIN_PASSWORD, `192.0.2.${i}:1000`)).status).toBe(200);
    }
    expect((await login(ADMIN_PASSWORD, "198.51.100.7:1234")).status).toBe(200);
  });

  it("同時にたくさん送っても、上限の回数までしか試せない", async () => {
    const results = await Promise.all(Array.from({ length: 30 }, () => login("wrong")));
    expect(results.filter((r) => r.status === 401)).toHaveLength(ADMIN_LOGIN_MAX_PER_SOURCE);
    expect(results.filter((r) => r.status === 429)).toHaveLength(30 - ADMIN_LOGIN_MAX_PER_SOURCE);
  });

  it("記録を消す（Unlock admin login）と、すぐにまた入れる", async () => {
    await failTimes(ADMIN_LOGIN_MAX_PER_SOURCE);
    expect(await repo.clearAdminLoginAttempts()).toBe(2);
    expect((await login(ADMIN_PASSWORD)).status).toBe(200);
  });
});
