import { PHOTO_PENDING_MAX, PHOTO_UPLOAD_MAX_PER_WINDOW, PHOTO_UPLOAD_WINDOW_MS } from "@partally/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { ingestUpload } from "./ingest.js";
import { MemoryRepository } from "./memory-repository.js";
import { MemoryPhotoStorage } from "./memory-storage.js";
import { DEFAULT_SETTINGS } from "./repository.js";
import { ADMIN_PASSWORD, type Client, createClient, jpegBytes, testSigner } from "./test-support.js";

/** 区切りの始まり（10 分の区切りにそろった時刻） */
const WINDOW_START = Date.parse("2026-11-24T10:00:00.000Z");

describe("写真のアップロードの上限", () => {
  let repo: MemoryRepository;
  let storage: MemoryPhotoStorage;
  let app: ReturnType<typeof createApp>;
  let nowMs: number;
  let id = 0;

  beforeEach(() => {
    repo = new MemoryRepository();
    storage = new MemoryPhotoStorage();
    nowMs = WINDOW_START + 60_000;
    app = createApp({
      repo,
      storage,
      signer: testSigner,
      sessionSecret: "test-secret",
      adminPassword: ADMIN_PASSWORD,
      secureCookies: true,
      now: () => new Date(nowMs),
      newId: () => `ID${String(++id).padStart(4, "0")}`,
    });
  });

  async function participant() {
    const admin = createClient(app);
    await admin("POST", "/api/admin/login", { password: ADMIN_PASSWORD });
    const { tokens } = (await admin("POST", "/api/admin/tokens", { count: 1 })).body;
    const request = createClient(app);
    await request("POST", "/api/auth/register", { token: tokens[0].token, name: "田中", pin: "1234" });
    return { request, admin };
  }

  /** 枠を取り、受け口に置いて取り込む（画面からの送信と同じ流れ） */
  async function upload(request: Client) {
    const res = await request("POST", "/api/photos/upload-url");
    if (res.status !== 200) return res;
    for (const kind of ["thumb", "full"] as const) {
      const { fields } = res.body[kind];
      storage.put(fields.key, jpegBytes(), fields["x-amz-meta-uploader"]);
    }
    await ingestUpload({ repo, storage }, res.body.full.fields.key);
    return res;
  }

  it("確認待ちが上限に達すると、新しく枠を取れない。幹事が承認・却下して減れば、また取れる", async () => {
    const { request, admin } = await participant();
    const ids: string[] = [];
    for (let i = 0; i < PHOTO_PENDING_MAX; i++) {
      // 発行の上限にかからないよう、区切りを進めながら送る
      if (i > 0 && i % PHOTO_UPLOAD_MAX_PER_WINDOW === 0) nowMs += PHOTO_UPLOAD_WINDOW_MS;
      const res = await upload(request);
      expect(res.status).toBe(200);
      ids.push(res.body.photoId);
    }
    nowMs += PHOTO_UPLOAD_WINDOW_MS;
    const refused = await request("POST", "/api/photos/upload-url");
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({
      error: "too_many_pending",
      message: `確認待ちの写真が ${PHOTO_PENDING_MAX} 枚あります`,
    });

    await admin("POST", `/api/admin/photos/${ids[0]}/approve`);
    expect((await upload(request)).status).toBe(200);
    expect((await request("POST", "/api/photos/upload-url")).status).toBe(429);
    await admin("POST", `/api/admin/photos/${ids[1]}/reject`);
    expect((await request("POST", "/api/photos/upload-url")).status).toBe(200);
  });

  it("公開済みの写真は確認待ちに数えない（アップロードと同時に公開する設定）", async () => {
    const { request } = await participant();
    await repo.putSettings({ ...DEFAULT_SETTINGS, moderation: "post" });
    for (let i = 0; i < PHOTO_PENDING_MAX + 1; i++) {
      if (i > 0 && i % PHOTO_UPLOAD_MAX_PER_WINDOW === 0) nowMs += PHOTO_UPLOAD_WINDOW_MS;
      expect((await upload(request)).status).toBe(200);
    }
  });

  it("区切りの中で発行の上限まで取ると断り、あと何分かを返す。断ったものは数えず、区切りが変わるとまた取れる", async () => {
    const { request } = await participant();
    await repo.putSettings({ ...DEFAULT_SETTINGS, moderation: "post" });
    for (let i = 0; i < PHOTO_UPLOAD_MAX_PER_WINDOW; i++) {
      expect((await request("POST", "/api/photos/upload-url")).status).toBe(200);
    }
    for (let i = 0; i < 3; i++) {
      const refused = await request("POST", "/api/photos/upload-url");
      expect(refused.status).toBe(429);
      expect(refused.body).toEqual({ error: "upload_rate_limited", message: "あと 9 分" });
      expect(refused.headers.get("retry-after")).toBe(String(9 * 60));
    }
    nowMs = WINDOW_START + PHOTO_UPLOAD_WINDOW_MS;
    expect((await request("POST", "/api/photos/upload-url")).status).toBe(200);
  });

  it("上限は参加者ごとに数える", async () => {
    const first = await participant();
    const second = await participant();
    for (let i = 0; i < PHOTO_UPLOAD_MAX_PER_WINDOW; i++) await first.request("POST", "/api/photos/upload-url");
    expect((await first.request("POST", "/api/photos/upload-url")).status).toBe(429);
    expect((await second.request("POST", "/api/photos/upload-url")).status).toBe(200);
  });
});
