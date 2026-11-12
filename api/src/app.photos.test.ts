import { describe, expect, it, vi } from "vitest";
import { ingestUpload } from "./ingest.js";
import { photoKey } from "./photo-storage.js";
import { DEFAULT_SETTINGS } from "./repository.js";
import { ADMIN_PASSWORD, type Client, createClient, useApiTest } from "./test-support.js";

describe("API", () => {
  const t = useApiTest();

  describe("写真", () => {
    async function registerUser(name = "田中") {
      const token = await t.issueToken();
      const request = createClient(t.app);
      const reg = await request("POST", "/api/auth/register", { token, name });
      return { request, userId: reg.body.user.userId as string, reg };
    }

    const adminClient = () => t.adminClient();

    /** 署名付き POST を受け取り、ブラウザの代わりにストレージへ置いて取り込む */
    async function upload(request: Client) {
      const res = await request("POST", "/api/photos/upload-url");
      expect(res.status).toBe(200);
      for (const kind of ["thumb", "full"] as const) {
        const { fields } = res.body[kind];
        t.storage.put(fields.key, new Uint8Array([1, 2, 3]), fields["x-amz-meta-uploader"]);
      }
      const result = await ingestUpload({ repo: t.repo, storage: t.storage }, res.body.full.fields.key);
      return { photoId: res.body.photoId as string, result };
    }

    it("ログイン時に公開写真用の Cookie を /photos/approved/ に発行する", async () => {
      const { reg } = await registerUser();
      const photoCookies = reg.headers.getSetCookie().filter((c) => c.startsWith("CloudFront-"));
      expect(photoCookies).toHaveLength(2);
      expect(photoCookies[0]).toMatch(/Path=\/photos\/approved\//);
      expect(photoCookies[0]).toMatch(/HttpOnly/);
    });

    it("アップロード用 URL は参加者のログインが必要で、アップロード者を固定する", async () => {
      expect((await createClient(t.app)("POST", "/api/photos/upload-url")).status).toBe(401);
      const { request, userId } = await registerUser();
      const res = await request("POST", "/api/photos/upload-url");
      expect(res.body.full.fields).toMatchObject({
        key: `uploads/${res.body.photoId}/full.jpg`,
        "x-amz-meta-uploader": userId,
      });
      expect(res.body.thumb.fields.key).toBe(`uploads/${res.body.photoId}/thumb.jpg`);
    });

    it("一覧の続きを読む位置（cursor）が壊れていたら 400", async () => {
      const { request } = await registerUser();
      const admin = await adminClient();
      for (const cursor of ["abc", "-1", "1.5"]) {
        expect((await request("GET", `/api/photos?cursor=${cursor}`)).status).toBe(400);
        expect((await admin("GET", `/api/admin/photos?status=pending&cursor=${cursor}`)).status).toBe(400);
      }
      expect((await request("GET", "/api/photos?cursor=0")).status).toBe(200);
    });

    it("同じ写真への承認が同時に 2 つ来ても、公開した画像は消えない", async () => {
      const { request } = await registerUser();
      const { photoId } = await upload(request);
      const admin = await adminClient();
      const results = await Promise.all([
        admin("POST", `/api/admin/photos/${photoId}/approve`),
        admin("POST", `/api/admin/photos/${photoId}/approve`),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      // 負けた方が、勝った方の公開した画像を消さない
      expect(t.storage.get(photoKey("approved", photoId, "full"))).toBeDefined();
      expect(t.storage.get(photoKey("approved", photoId, "thumb"))).toBeDefined();
      expect(t.storage.get(photoKey("pending", photoId, "full"))).toBeUndefined();
      expect((await request("GET", "/api/photos")).body.photos).toHaveLength(1);
    });

    it("承認の途中で別の承認が済んで検閲待ちの画像が無くなっていたら 409 にし、公開した画像は残す", async () => {
      const { request } = await registerUser();
      const { photoId } = await upload(request);
      const admin = await adminClient();
      // 1 つ目の承認がコピーしようとした時点で、別の承認が全部済んでいる（検閲待ちの画像はもう無い）
      const copy = vi.spyOn(t.storage, "copy").mockImplementationOnce(async () => {
        expect((await admin("POST", `/api/admin/photos/${photoId}/approve`)).status).toBe(200);
        throw new Error("コピー元がありません");
      });
      try {
        expect((await admin("POST", `/api/admin/photos/${photoId}/approve`)).status).toBe(409);
      } finally {
        copy.mockRestore();
      }
      expect(t.storage.get(photoKey("approved", photoId, "full"))).toBeDefined();
      expect((await request("GET", "/api/photos")).body.photos).toHaveLength(1);
    });

    it("検閲待ちのままコピーに失敗したら、エラーにして検閲待ちのままにする", async () => {
      const { request } = await registerUser();
      const { photoId } = await upload(request);
      const admin = await adminClient();
      const copy = vi.spyOn(t.storage, "copy").mockRejectedValueOnce(new Error("S3 の一時的なエラー"));
      try {
        expect((await admin("POST", `/api/admin/photos/${photoId}/approve`)).status).toBe(500);
      } finally {
        copy.mockRestore();
      }
      expect((await admin("GET", "/api/admin/photos?status=pending")).body.photos).toHaveLength(1);
      // もう一度承認すれば公開できる
      expect((await admin("POST", `/api/admin/photos/${photoId}/approve`)).status).toBe(200);
    });

    it("承認と却下が同時に来ても、状態と画像が食い違わない", async () => {
      const { request } = await registerUser();
      const { photoId } = await upload(request);
      const admin = await adminClient();
      const [approve, reject] = await Promise.all([
        admin("POST", `/api/admin/photos/${photoId}/approve`),
        admin("POST", `/api/admin/photos/${photoId}/reject`),
      ]);
      expect([approve.status, reject.status].sort()).toEqual([200, 409]);
      const published = t.storage.get(photoKey("approved", photoId, "full")) !== undefined;
      // 承認が勝てば公開した画像があり、却下が勝てば無い
      expect(published).toBe(approve.status === 200);
      expect((await request("GET", "/api/photos")).body.photos).toHaveLength(published ? 1 : 0);
    });

    it("事前承認モード: 検閲待ち → 承認で公開され、カウンタが増える", async () => {
      const { request, userId } = await registerUser();
      const { photoId, result } = await upload(request);
      expect(result).toBe("created");

      // 本人には検閲待ちとして署名付き URL で見え、ギャラリーにはまだ出ない
      const mine = await request("GET", "/api/photos/mine");
      expect(mine.body.photos[0]).toMatchObject({
        photoId,
        status: "pending",
        thumbUrl: `/photos/pending/${photoId}/thumb.jpg?signed`,
      });
      expect((await request("GET", "/api/photos")).body.photos).toEqual([]);
      expect((await request("GET", "/api/me")).body.user).toMatchObject({ uploadCount: 1, approvedCount: 0 });

      const admin = await adminClient();
      const pending = await admin("GET", "/api/admin/photos?status=pending");
      expect(pending.body.photos[0]).toMatchObject({ photoId, uploaderName: "〈疾風の魔術師〉田中" });

      const approved = await admin("POST", `/api/admin/photos/${photoId}/approve`);
      expect(approved.status).toBe(200);
      expect(approved.body.photo.fullUrl).toBe(`/photos/approved/${photoId}/full.jpg?signed`);
      expect(t.storage.get(photoKey("approved", photoId, "full"))).toBeDefined();
      expect(t.storage.get(photoKey("pending", photoId, "full"))).toBeUndefined();

      // 参加者のギャラリーでは Cookie で見るので署名なしのパス
      const gallery = await request("GET", "/api/photos");
      expect(gallery.body.photos).toEqual([
        expect.objectContaining({
          photoId,
          uploaderId: userId,
          uploaderName: "〈疾風の魔術師〉田中",
          thumbUrl: `/photos/approved/${photoId}/thumb.jpg`,
          fullUrl: `/photos/approved/${photoId}/full.jpg`,
        }),
      ]);
      expect((await request("GET", "/api/me")).body.user).toMatchObject({ uploadCount: 1, approvedCount: 1 });

      // 二重承認は 409
      expect((await admin("POST", `/api/admin/photos/${photoId}/approve`)).status).toBe(409);
    });

    it("却下すると画像が消え、アップロード数から除かれる", async () => {
      const { request } = await registerUser();
      const { photoId } = await upload(request);
      const admin = await adminClient();

      const rejected = await admin("POST", `/api/admin/photos/${photoId}/reject`);
      expect(rejected.body.photo).toMatchObject({ status: "rejected" });
      expect(rejected.body.photo.thumbUrl).toBeUndefined();
      expect(t.storage.objects.size).toBe(0);
      expect((await request("GET", "/api/me")).body.user.uploadCount).toBe(0);
      expect((await request("GET", "/api/photos/mine")).body.photos[0].status).toBe("rejected");
      expect((await admin("POST", `/api/admin/photos/${photoId}/reject`)).status).toBe(409);
    });

    it("公開済みの写真を削除すると、画像・カウンタ・CDN キャッシュが片付く", async () => {
      const { request } = await registerUser();
      const { photoId } = await upload(request);
      const admin = await adminClient();

      // 検閲待ちは削除ではなく却下する
      expect((await admin("DELETE", `/api/admin/photos/${photoId}`)).status).toBe(409);

      await admin("POST", `/api/admin/photos/${photoId}/approve`);
      expect((await admin("DELETE", `/api/admin/photos/${photoId}`)).status).toBe(200);
      expect(t.storage.objects.size).toBe(0);
      expect(t.storage.invalidated).toEqual([photoId]);
      expect((await request("GET", "/api/photos")).body.photos).toEqual([]);
      expect((await request("GET", "/api/me")).body.user).toMatchObject({ uploadCount: 0, approvedCount: 0 });
      // 削除済みの記録は残り、自分の写真にも出ない
      expect((await request("GET", "/api/photos/mine")).body.photos).toEqual([]);
      // 削除済みの写真をもう一度削除すると、後片付けだけをやり直す（カウンタは二重に減らない）
      expect((await admin("DELETE", `/api/admin/photos/${photoId}`)).status).toBe(200);
      expect((await request("GET", "/api/me")).body.user).toMatchObject({ uploadCount: 0, approvedCount: 0 });
      expect((await admin("DELETE", "/api/admin/photos/NOPE")).status).toBe(404);
    });

    it("即時公開モード: 取り込み時に公開される", async () => {
      const admin = await adminClient();
      expect((await admin("GET", "/api/admin/settings")).body.settings).toEqual(DEFAULT_SETTINGS);
      expect((await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, moderation: "post" })).status).toBe(200);
      expect((await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, moderation: "x" })).status).toBe(400);
      expect((await admin("PUT", "/api/admin/settings", { moderation: "post" })).status).toBe(400);
      // 同じポイントのときの優先順は、5 つの項目をすべて 1 回ずつ並べたものだけ
      const order = (tieBreakOrder: unknown) =>
        admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, moderation: "post", tieBreakOrder }).then(
          (r) => r.status,
        );
      expect(await order(["registered", "game", "upload", "favoriteReceived", "favoriteGiven"])).toBe(200);
      expect(await order(["registered", "upload", "favoriteReceived", "favoriteGiven"])).toBe(400);
      // 以前あった quiz の項目は受け付けない
      expect(await order(["quiz", "registered", "game", "upload", "favoriteReceived", "favoriteGiven"])).toBe(400);
      expect(await order(["game", "game", "upload", "favoriteReceived", "favoriteGiven"])).toBe(400);
      expect((await admin("GET", "/api/admin/settings")).body.settings.tieBreakOrder).toEqual([
        "registered",
        "game",
        "upload",
        "favoriteReceived",
        "favoriteGiven",
      ]);

      const { request } = await registerUser();
      const { photoId } = await upload(request);
      expect((await request("GET", "/api/photos")).body.photos.map((p: any) => p.photoId)).toEqual([photoId]);
      expect(t.storage.get(photoKey("pending", photoId, "full"))).toBeUndefined();
      expect((await request("GET", "/api/me")).body.user).toMatchObject({ uploadCount: 1, approvedCount: 1 });
    });

    it("ギャラリーは新しい順にページングする", async () => {
      const { request } = await registerUser();
      await t.repo.putSettings({ ...DEFAULT_SETTINGS, moderation: "post" });
      const ids: string[] = [];
      for (let i = 0; i < 31; i++) ids.push((await upload(request)).photoId);

      const first = await request("GET", "/api/photos");
      expect(first.body.photos).toHaveLength(30);
      expect(first.body.cursor).toBeDefined();
      const second = await request("GET", `/api/photos?cursor=${first.body.cursor}`);
      expect(second.body.photos).toHaveLength(1);
      expect(second.body.cursor).toBeUndefined();
      expect([...first.body.photos, ...second.body.photos].map((p: any) => p.photoId)).toEqual(ids.reverse());
    });

    it("管理 API は管理者のみ", async () => {
      const { request } = await registerUser();
      expect((await request("GET", "/api/admin/photos")).status).toBe(401);
      expect((await request("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, moderation: "post" })).status).toBe(
        401,
      );
    });
  });

  describe("写真（レビュー指摘の回帰テスト）", () => {
    async function setup() {
      const token = await t.issueToken();
      const request = createClient(t.app);
      await request("POST", "/api/auth/register", { token, name: "田中" });
      const admin = createClient(t.app);
      await admin("POST", "/api/admin/login", { password: ADMIN_PASSWORD });
      return { request, admin };
    }

    async function uploadWith(request: Client, bytes: number[]) {
      const res = await request("POST", "/api/photos/upload-url");
      for (const kind of ["thumb", "full"] as const) {
        const { fields } = res.body[kind];
        t.storage.put(fields.key, new Uint8Array(bytes), fields["x-amz-meta-uploader"]);
      }
      return {
        photoId: res.body.photoId as string,
        forms: res.body,
        result: await ingestUpload({ repo: t.repo, storage: t.storage }, res.body.full.fields.key),
      };
    }

    it("取り込み後に同じ署名付き POST で再アップロードしても、検閲待ちの画像は差し替わらない", async () => {
      const { request, admin } = await setup();
      const { photoId, forms } = await uploadWith(request, [1]);
      expect(t.storage.get(photoKey("uploads", photoId, "full"))).toBeUndefined();

      // 同じフォームで別の画像を送り直す
      t.storage.put(forms.thumb.fields.key, new Uint8Array([9]), forms.thumb.fields["x-amz-meta-uploader"]);
      t.storage.put(forms.full.fields.key, new Uint8Array([9]), forms.full.fields["x-amz-meta-uploader"]);
      expect(await ingestUpload({ repo: t.repo, storage: t.storage }, forms.full.fields.key)).toBe("duplicate");
      expect(t.storage.get(photoKey("uploads", photoId, "full"))).toBeUndefined();

      await admin("POST", `/api/admin/photos/${photoId}/approve`);
      expect([...t.storage.get(photoKey("approved", photoId, "full"))!]).toEqual([1]);
    });

    it("削除した写真は同じ署名付き POST で再アップロードしても復活しない", async () => {
      const { request, admin } = await setup();
      await t.repo.putSettings({ ...DEFAULT_SETTINGS, moderation: "post" });
      const { photoId, forms } = await uploadWith(request, [1]);
      await admin("DELETE", `/api/admin/photos/${photoId}`);

      t.storage.put(forms.thumb.fields.key, new Uint8Array([1]), forms.thumb.fields["x-amz-meta-uploader"]);
      t.storage.put(forms.full.fields.key, new Uint8Array([1]), forms.full.fields["x-amz-meta-uploader"]);
      expect(await ingestUpload({ repo: t.repo, storage: t.storage }, forms.full.fields.key)).toBe("duplicate");
      expect(t.storage.get(photoKey("approved", photoId, "full"))).toBeUndefined();
      expect((await request("GET", "/api/photos")).body.photos).toEqual([]);
    });

    it("承認の DB 更新が失敗したら、公開領域へのコピーを取り消す", async () => {
      const { request, admin } = await setup();
      const { photoId } = await uploadWith(request, [1]);
      // 承認処理の途中で別の操作により却下された状況を再現する
      vi.spyOn(t.repo, "approvePhoto").mockImplementationOnce(async () => {
        await t.repo.rejectPhoto(photoId, "2026-01-01T00:00:00.000Z");
        throw new (await import("./repository.js")).InvalidStateError();
      });
      expect((await admin("POST", `/api/admin/photos/${photoId}/approve`)).status).toBe(409);
      expect(t.storage.get(photoKey("approved", photoId, "full"))).toBeUndefined();
    });

    it("一覧の取得時にも写真用 Cookie を更新する", async () => {
      const { request } = await setup();
      for (const path of ["/api/photos", "/api/photos/mine"]) {
        const res = await request("GET", path);
        expect(res.headers.getSetCookie().some((c) => c.startsWith("CloudFront-Policy="))).toBe(true);
      }
    });
  });
});
