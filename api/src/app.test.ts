import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildRanking, createApp, scoreQuizAnswers } from "./app.js";
import { ingestUpload } from "./ingest.js";
import { MemoryRepository } from "./memory-repository.js";
import { MemoryPhotoStorage } from "./memory-storage.js";
import { photoKey } from "./photo-storage.js";
import { DEFAULT_SETTINGS, type UserRecord } from "./repository.js";
import type { UrlSigner } from "./url-signer.js";

const ADMIN_PASSWORD = "secret-password";

/** 署名の代わりに印を付けるだけの署名器 */
const testSigner: UrlSigner = {
  approvedCookies: () => ({ "CloudFront-Policy": "policy", "CloudFront-Signature": "sig" }),
  signPath: (path) => `${path}?signed`,
};

/** Set-Cookie を保持して次のリクエストに付ける簡易クライアント */
function createClient(app: ReturnType<typeof createApp>) {
  const jar = new Map<string, string>();

  return async function request(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (body !== undefined || method !== "GET") headers["content-type"] = "application/json";
    // パスに関係なくすべての Cookie を送る（Path 属性の扱いは実ブラウザに任せる）
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

    const res = await app.request(path, {
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const [name, value] = pair!.split("=");
      if (/max-age=0/i.test(cookie) || value === "") jar.delete(name!);
      else jar.set(name!, value!);
    }
    return { status: res.status, body: (await res.json()) as any, headers: res.headers };
  };
}

describe("API", () => {
  let repo: MemoryRepository;
  let storage: MemoryPhotoStorage;
  let app: ReturnType<typeof createApp>;
  let epithetSeq: number[];

  beforeEach(() => {
    repo = new MemoryRepository();
    storage = new MemoryPhotoStorage();
    epithetSeq = [];
    let id = 0;
    app = createApp({
      repo,
      storage,
      signer: testSigner,
      sessionSecret: "test-secret",
      adminPassword: ADMIN_PASSWORD,
      secureCookies: true,
      // 二つ名の抽選結果をテストから指定できるようにする（未指定なら 0）
      randomInt: () => epithetSeq.shift() ?? 0,
      // 本番の ULID と同じく、文字列順が発行順になるようにする
      newId: () => `ID${String(++id).padStart(4, "0")}`,
    });
  });

  let tokenSeq = 0;
  async function issueToken() {
    const [t] = await repo.createTokens([`tok${++tokenSeq}`.padEnd(22, "x")], "2026-01-01T00:00:00.000Z");
    return t!.token;
  }

  describe("QR ログイン・初回登録", () => {
    it("未紐づけトークンは unbound を返し、名前登録で二つ名が付く", async () => {
      const token = await issueToken();
      const request = createClient(app);

      const qr = await request("POST", "/api/auth/qr", { token });
      expect(qr.status).toBe(200);
      expect(qr.body).toEqual({ status: "unbound" });

      const reg = await request("POST", "/api/auth/register", { token, name: " 田中　太郎 " });
      expect(reg.status).toBe(201);
      expect(reg.body.user).toMatchObject({
        name: "田中 太郎",
        epithet: "疾風の魔術師",
        displayName: "〈疾風の魔術師〉田中 太郎",
        status: "active",
        uploadCount: 0,
      });

      const cookie = reg.headers.getSetCookie()[0]!;
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Secure/);
      expect(cookie).toMatch(/SameSite=Lax/);

      const me = await request("GET", "/api/me");
      expect(me.status).toBe(200);
      expect(me.body.user.userId).toBe(reg.body.user.userId);
    });

    it("紐づけ済みトークンは QR だけでログインできる（別端末）", async () => {
      const token = await issueToken();
      await createClient(app)("POST", "/api/auth/register", { token, name: "田中" });

      const other = createClient(app);
      expect((await other("GET", "/api/me")).status).toBe(401);
      const qr = await other("POST", "/api/auth/qr", { token });
      expect(qr.body).toMatchObject({ status: "bound", user: { name: "田中" } });
      expect((await other("GET", "/api/me")).status).toBe(200);
    });

    it("同名でも二つ名が重複しないよう再抽選する", async () => {
      const t1 = await issueToken();
      const t2 = await issueToken();
      const request = createClient(app);

      // 1 人目: (0,0)。2 人目: 最初に (0,0) が出て衝突 → (0,1) で確定
      epithetSeq = [0, 0];
      const a = await request("POST", "/api/auth/register", { token: t1, name: "田中" });
      epithetSeq = [0, 0, 0, 1];
      const b = await request("POST", "/api/auth/register", { token: t2, name: "田中" });

      expect(a.body.user.epithet).toBe("疾風の魔術師");
      expect(b.body.user.epithet).toBe("疾風の剣士");
    });

    it("存在しないトークンは 404、紐づけ済みトークンへの登録は 409", async () => {
      const request = createClient(app);
      const unknown = "b".repeat(22);
      expect((await request("POST", "/api/auth/qr", { token: unknown })).body.error).toBe("invalid_token");

      const token = await issueToken();
      await request("POST", "/api/auth/register", { token, name: "田中" });
      const again = await request("POST", "/api/auth/register", { token, name: "鈴木" });
      expect(again.status).toBe(409);
      expect(again.body.error).toBe("token_already_bound");
    });

    it("形式不正な入力は 400、JSON 以外は 415", async () => {
      const request = createClient(app);
      expect((await request("POST", "/api/auth/qr", { token: "short" })).status).toBe(400);
      const token = await issueToken();
      expect((await request("POST", "/api/auth/register", { token, name: "　" })).status).toBe(400);

      const res = await app.request("/api/auth/qr", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ token }),
      });
      expect(res.status).toBe(415);
    });

    it("改ざんされたセッション Cookie は拒否する", async () => {
      const res = await app.request("/api/me", {
        headers: { cookie: "session=eyJ1aWQiOiJ1c2VyLTEiLCJ0b2siOiJ4IiwiaWF0IjoxfQ.forged" },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("管理者", () => {
    async function adminClient() {
      const request = createClient(app);
      const login = await request("POST", "/api/admin/login", { password: ADMIN_PASSWORD });
      expect(login.status).toBe(200);
      expect(login.headers.getSetCookie()[0]).toMatch(/Path=\/api\/admin/);
      return request;
    }

    it("パスワードが違えばログインできず、管理 API は 401", async () => {
      const request = createClient(app);
      expect((await request("POST", "/api/admin/login", { password: "wrong" })).status).toBe(401);
      expect((await request("GET", "/api/admin/users")).status).toBe(401);
      expect((await request("GET", "/api/admin/me")).status).toBe(401);
    });

    it("参加者のセッションでは管理 API を使えない", async () => {
      const token = await issueToken();
      const request = createClient(app);
      await request("POST", "/api/auth/register", { token, name: "田中" });
      expect((await request("GET", "/api/admin/users")).status).toBe(401);
    });

    it("トークンを発行すると通し番号付きで一覧に並び、紐づけ先が表示される", async () => {
      const admin = await adminClient();
      const issued = await admin("POST", "/api/admin/tokens", { count: 3 });
      expect(issued.status).toBe(201);
      expect(issued.body.tokens.map((t: any) => t.label)).toEqual(["001", "002", "003"]);
      expect(issued.body.tokens[0].token).toMatch(/^[A-Za-z0-9_-]{22}$/);

      const token = issued.body.tokens[1].token;
      await createClient(app)("POST", "/api/auth/register", { token, name: "田中" });

      const list = await admin("GET", "/api/admin/tokens");
      expect(list.body.tokens).toHaveLength(3);
      expect(list.body.tokens[1]).toMatchObject({ status: "bound", displayName: "〈疾風の魔術師〉田中" });
      expect(list.body.tokens[0].status).toBe("unbound");
    });

    it("発行数は 1〜200 に制限する", async () => {
      const admin = await adminClient();
      expect((await admin("POST", "/api/admin/tokens", { count: 0 })).status).toBe(400);
      expect((await admin("POST", "/api/admin/tokens", { count: 201 })).status).toBe(400);
    });

    it("名前・二つ名を変更でき、使用中の二つ名には変更できない", async () => {
      const t1 = await issueToken();
      const t2 = await issueToken();
      epithetSeq = [0, 0];
      const a = await createClient(app)("POST", "/api/auth/register", { token: t1, name: "田中" });
      epithetSeq = [0, 1];
      const b = await createClient(app)("POST", "/api/auth/register", { token: t2, name: "鈴木" });
      const admin = await adminClient();

      const renamed = await admin("PATCH", `/api/admin/users/${a.body.user.userId}`, {
        name: "田中 一郎",
        epithet: "宴の幹事",
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body.user.displayName).toBe("〈宴の幹事〉田中 一郎");

      // 田中さんが手放した二つ名は再利用できる
      const reuse = await admin("PATCH", `/api/admin/users/${b.body.user.userId}`, { epithet: "疾風の魔術師" });
      expect(reuse.status).toBe(200);

      const taken = await admin("PATCH", `/api/admin/users/${b.body.user.userId}`, { epithet: "宴の幹事" });
      expect(taken.status).toBe(409);
      expect(taken.body.error).toBe("epithet_taken");

      expect((await admin("PATCH", "/api/admin/users/nobody", { name: "x" })).status).toBe(404);
    });

    it("紐づけ解除すると旧セッションは無効になり、トークンは再登録できる", async () => {
      const token = await issueToken();
      const participant = createClient(app);
      const reg = await participant("POST", "/api/auth/register", { token, name: "田中" });
      const admin = await adminClient();

      const unbind = await admin("POST", `/api/admin/users/${reg.body.user.userId}/unbind`);
      expect(unbind.status).toBe(200);
      expect(unbind.body.user.status).toBe("unbound");
      expect((await admin("POST", `/api/admin/users/${reg.body.user.userId}/unbind`)).status).toBe(404);

      expect((await participant("GET", "/api/me")).status).toBe(401);
      expect((await participant("POST", "/api/auth/qr", { token })).body).toEqual({ status: "unbound" });

      // 解除済みユーザの二つ名は確保されたままなので、別の二つ名になる
      epithetSeq = [0, 0, 0, 1];
      const again = await participant("POST", "/api/auth/register", { token, name: "鈴木" });
      expect(again.status).toBe(201);
      expect(again.body.user.userId).not.toBe(reg.body.user.userId);
      expect(again.body.user.epithet).toBe("疾風の剣士");

      const users = await admin("GET", "/api/admin/users");
      expect(users.body.users.map((u: any) => [u.name, u.status])).toEqual([
        ["田中", "unbound"],
        ["鈴木", "active"],
      ]);
    });
  });

  describe("写真", () => {
    async function registerUser(name = "田中") {
      const token = await issueToken();
      const request = createClient(app);
      const reg = await request("POST", "/api/auth/register", { token, name });
      return { request, userId: reg.body.user.userId as string, reg };
    }

    async function adminClient() {
      const request = createClient(app);
      await request("POST", "/api/admin/login", { password: ADMIN_PASSWORD });
      return request;
    }

    /** 署名付き POST を受け取り、ブラウザの代わりにストレージへ置いて取り込む */
    async function upload(request: ReturnType<typeof createClient>) {
      const res = await request("POST", "/api/photos/upload-url");
      expect(res.status).toBe(200);
      for (const kind of ["thumb", "full"] as const) {
        const { fields } = res.body[kind];
        storage.put(fields.key, new Uint8Array([1, 2, 3]), fields["x-amz-meta-uploader"]);
      }
      const result = await ingestUpload({ repo, storage }, res.body.full.fields.key);
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
      expect((await createClient(app)("POST", "/api/photos/upload-url")).status).toBe(401);
      const { request, userId } = await registerUser();
      const res = await request("POST", "/api/photos/upload-url");
      expect(res.body.full.fields).toMatchObject({
        key: `uploads/${res.body.photoId}/full.jpg`,
        "x-amz-meta-uploader": userId,
      });
      expect(res.body.thumb.fields.key).toBe(`uploads/${res.body.photoId}/thumb.jpg`);
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
      expect(storage.get(photoKey("approved", photoId, "full"))).toBeDefined();
      expect(storage.get(photoKey("pending", photoId, "full"))).toBeUndefined();

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
      expect(storage.objects.size).toBe(0);
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
      expect(storage.objects.size).toBe(0);
      expect(storage.invalidated).toEqual([photoId]);
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

      const { request } = await registerUser();
      const { photoId } = await upload(request);
      expect((await request("GET", "/api/photos")).body.photos.map((p: any) => p.photoId)).toEqual([photoId]);
      expect(storage.get(photoKey("pending", photoId, "full"))).toBeUndefined();
      expect((await request("GET", "/api/me")).body.user).toMatchObject({ uploadCount: 1, approvedCount: 1 });
    });

    it("ギャラリーは新しい順にページングする", async () => {
      const { request } = await registerUser();
      await repo.putSettings({ ...DEFAULT_SETTINGS, moderation: "post" });
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
      const token = await issueToken();
      const request = createClient(app);
      await request("POST", "/api/auth/register", { token, name: "田中" });
      const admin = createClient(app);
      await admin("POST", "/api/admin/login", { password: ADMIN_PASSWORD });
      return { request, admin };
    }

    async function uploadWith(request: ReturnType<typeof createClient>, bytes: number[]) {
      const res = await request("POST", "/api/photos/upload-url");
      for (const kind of ["thumb", "full"] as const) {
        const { fields } = res.body[kind];
        storage.put(fields.key, new Uint8Array(bytes), fields["x-amz-meta-uploader"]);
      }
      return {
        photoId: res.body.photoId as string,
        forms: res.body,
        result: await ingestUpload({ repo, storage }, res.body.full.fields.key),
      };
    }

    it("取り込み後に同じ署名付き POST で再アップロードしても、検閲待ちの画像は差し替わらない", async () => {
      const { request, admin } = await setup();
      const { photoId, forms } = await uploadWith(request, [1]);
      expect(storage.get(photoKey("uploads", photoId, "full"))).toBeUndefined();

      // 同じフォームで別の画像を送り直す
      storage.put(forms.thumb.fields.key, new Uint8Array([9]), forms.thumb.fields["x-amz-meta-uploader"]);
      storage.put(forms.full.fields.key, new Uint8Array([9]), forms.full.fields["x-amz-meta-uploader"]);
      expect(await ingestUpload({ repo, storage }, forms.full.fields.key)).toBe("duplicate");
      expect(storage.get(photoKey("uploads", photoId, "full"))).toBeUndefined();

      await admin("POST", `/api/admin/photos/${photoId}/approve`);
      expect([...storage.get(photoKey("approved", photoId, "full"))!]).toEqual([1]);
    });

    it("削除した写真は同じ署名付き POST で再アップロードしても復活しない", async () => {
      const { request, admin } = await setup();
      await repo.putSettings({ ...DEFAULT_SETTINGS, moderation: "post" });
      const { photoId, forms } = await uploadWith(request, [1]);
      await admin("DELETE", `/api/admin/photos/${photoId}`);

      storage.put(forms.thumb.fields.key, new Uint8Array([1]), forms.thumb.fields["x-amz-meta-uploader"]);
      storage.put(forms.full.fields.key, new Uint8Array([1]), forms.full.fields["x-amz-meta-uploader"]);
      expect(await ingestUpload({ repo, storage }, forms.full.fields.key)).toBe("duplicate");
      expect(storage.get(photoKey("approved", photoId, "full"))).toBeUndefined();
      expect((await request("GET", "/api/photos")).body.photos).toEqual([]);
    });

    it("承認の DB 更新が失敗したら、公開領域へのコピーを取り消す", async () => {
      const { request, admin } = await setup();
      const { photoId } = await uploadWith(request, [1]);
      // 承認処理の途中で別の操作により却下された状況を再現する
      vi.spyOn(repo, "approvePhoto").mockImplementationOnce(async () => {
        await repo.rejectPhoto(photoId, "2026-01-01T00:00:00.000Z");
        throw new (await import("./repository.js")).InvalidStateError();
      });
      expect((await admin("POST", `/api/admin/photos/${photoId}/approve`)).status).toBe(409);
      expect(storage.get(photoKey("approved", photoId, "full"))).toBeUndefined();
    });

    it("一覧の取得時にも写真用 Cookie を更新する", async () => {
      const { request } = await setup();
      for (const path of ["/api/photos", "/api/photos/mine"]) {
        const res = await request("GET", path);
        expect(res.headers.getSetCookie().some((c) => c.startsWith("CloudFront-Policy="))).toBe(true);
      }
    });
  });

  describe("ポイントとお気に入り", () => {
    let participantSeq = 0;
    async function participant(name: string) {
      const token = await issueToken();
      // 二つ名が重ならないよう、参加者ごとに称号を変える
      epithetSeq = [0, participantSeq++];
      const request = createClient(app);
      const reg = await request("POST", "/api/auth/register", { token, name });
      return { request, userId: reg.body.user.userId as string };
    }

    async function adminClient() {
      const request = createClient(app);
      await request("POST", "/api/admin/login", { password: ADMIN_PASSWORD });
      return request;
    }

    async function uploadAs(request: ReturnType<typeof createClient>) {
      const res = await request("POST", "/api/photos/upload-url");
      for (const kind of ["thumb", "full"] as const) {
        const { fields } = res.body[kind];
        storage.put(fields.key, new Uint8Array([1]), fields["x-amz-meta-uploader"]);
      }
      await ingestUpload({ repo, storage }, res.body.full.fields.key);
      return res.body.photoId as string;
    }

    async function setup() {
      await repo.putSettings({ ...DEFAULT_SETTINGS, moderation: "post" });
      const a = await participant("田中");
      const b = await participant("鈴木");
      const photoA1 = await uploadAs(a.request);
      const photoA2 = await uploadAs(a.request);
      const photoB = await uploadAs(b.request);
      return { a, b, photoA1, photoA2, photoB, admin: await adminClient() };
    }

    const me = async (request: ReturnType<typeof createClient>) => (await request("GET", "/api/me")).body;

    it("公開された写真 1 枚ごとにポイントが付き、設定を変えると現在の設定で数え直す", async () => {
      const { a, admin } = await setup();
      const before = await me(a.request);
      expect(before.user).toMatchObject({ approvedCount: 2, points: 2 });
      expect(before.rules).toEqual({
        uploadPoints: 1,
        favoritesEnabled: true,
        favoriteLimit: 10,
        favoritePoints: 1,
        showPoints: true,
      });

      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, moderation: "post", uploadPoints: 3 });
      expect((await me(a.request)).user.points).toBe(6);
      const users = (await admin("GET", "/api/admin/users")).body.users;
      expect(users.map((u: any) => [u.name, u.points])).toEqual([
        ["田中", 6],
        ["鈴木", 3],
      ]);
    });

    it("ポイントを伏せると、参加者向けの応答からポイント・選ばれた数・♥ の数を除く（管理画面では見える）", async () => {
      const { a, b, photoA1, admin } = await setup();
      await b.request("PUT", `/api/photos/${photoA1}/favorite`);
      expect((await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, showPoints: false })).status).toBe(200);

      const mine = await me(a.request);
      expect(mine.rules.showPoints).toBe(false);
      expect(mine.user).toMatchObject({ approvedCount: 2, favoritesGiven: 0 });
      expect(mine.user).not.toHaveProperty("points");
      expect(mine.user).not.toHaveProperty("favoritesReceived");
      for (const p of (await b.request("GET", "/api/photos")).body.photos)
        expect(p).not.toHaveProperty("favoriteCount");
      for (const p of (await a.request("GET", "/api/photos/mine")).body.photos)
        expect(p).not.toHaveProperty("favoriteCount");
      const res = await b.request("DELETE", `/api/photos/${photoA1}/favorite`);
      expect(res.body.photo).not.toHaveProperty("favoriteCount");
      expect(res.body.user).not.toHaveProperty("points");

      const users = (await admin("GET", "/api/admin/users")).body.users;
      expect(users.find((u: any) => u.name === "田中")).toMatchObject({ points: 2, favoritesReceived: 0 });
    });

    it("showPoints を送らない（古い画面からの）保存では、今の値を残す", async () => {
      const { admin } = await setup();
      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, showPoints: false });
      const { showPoints: _showPoints, ...withoutShowPoints } = DEFAULT_SETTINGS;
      const res = await admin("PUT", "/api/admin/settings", { ...withoutShowPoints, favoriteLimit: 5 });
      expect(res.status).toBe(200);
      expect(res.body.settings).toMatchObject({ showPoints: false, favoriteLimit: 5 });
      expect((await admin("GET", "/api/admin/settings")).body.settings.showPoints).toBe(false);
    });

    it("検閲待ちの写真はポイントにならない", async () => {
      await repo.putSettings({ ...DEFAULT_SETTINGS, moderation: "pre" });
      const a = await participant("田中");
      await uploadAs(a.request);
      expect((await me(a.request)).user).toMatchObject({ uploadCount: 1, approvedCount: 0, points: 0 });
    });

    it("他人の写真をお気に入りにすると、選ばれた人にポイントが付く。二重には数えない", async () => {
      const { a, b, photoA1 } = await setup();
      const res = await b.request("PUT", `/api/photos/${photoA1}/favorite`);
      expect(res.status).toBe(200);
      expect(res.body.photo).toMatchObject({ photoId: photoA1, favorited: true, favoriteCount: 1 });
      expect(res.body.user).toMatchObject({ favoritesGiven: 1 });
      expect((await b.request("PUT", `/api/photos/${photoA1}/favorite`)).status).toBe(200);

      expect((await me(a.request)).user).toMatchObject({ favoritesReceived: 1, points: 3 });
      expect((await me(b.request)).user).toMatchObject({ favoritesGiven: 1, points: 1 });

      const gallery = (await b.request("GET", "/api/photos")).body.photos;
      expect(gallery.find((p: any) => p.photoId === photoA1)).toMatchObject({ favorited: true, favoriteCount: 1 });
      expect(gallery.filter((p: any) => p.favorited)).toHaveLength(1);
    });

    it("自分の写真・検閲待ちの写真・存在しない写真は選べない", async () => {
      const { b, photoB, admin } = await setup();
      const self = await b.request("PUT", `/api/photos/${photoB}/favorite`);
      expect(self.status).toBe(409);
      expect(self.body.error).toBe("invalid_state");

      await admin("PUT", "/api/admin/settings", DEFAULT_SETTINGS);
      const c = await participant("佐藤");
      const pending = await uploadAs(c.request);
      expect((await b.request("PUT", `/api/photos/${pending}/favorite`)).body.error).toBe("invalid_state");
      expect((await b.request("PUT", "/api/photos/NOPE/favorite")).status).toBe(404);
    });

    it("選べる数には上限があり、外せば別の写真を選べる。外すと相手のポイントも減る", async () => {
      const { a, b, photoA1, photoA2, admin } = await setup();
      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, moderation: "post", favoriteLimit: 1 });

      await b.request("PUT", `/api/photos/${photoA1}/favorite`);
      const over = await b.request("PUT", `/api/photos/${photoA2}/favorite`);
      expect(over.status).toBe(409);
      expect(over.body.error).toBe("favorite_limit");

      const removed = await b.request("DELETE", `/api/photos/${photoA1}/favorite`);
      expect(removed.body.photo).toMatchObject({ favorited: false, favoriteCount: 0 });
      expect((await b.request("PUT", `/api/photos/${photoA2}/favorite`)).status).toBe(200);
      expect((await me(a.request)).user.favoritesReceived).toBe(1);
      // 選んでいない写真を外しても何も起きない
      expect((await b.request("DELETE", `/api/photos/${photoA1}/favorite`)).status).toBe(200);
      expect((await me(b.request)).user.favoritesGiven).toBe(1);
    });

    it("お気に入りを無効にすると追加も解除もできなくなるが、付いたポイントは残る", async () => {
      const { a, b, photoA1, photoA2, admin } = await setup();
      await b.request("PUT", `/api/photos/${photoA1}/favorite`);
      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, moderation: "post", favoritesEnabled: false });

      expect((await b.request("PUT", `/api/photos/${photoA2}/favorite`)).body.error).toBe("favorites_disabled");
      expect((await b.request("DELETE", `/api/photos/${photoA1}/favorite`)).body.error).toBe("favorites_disabled");
      expect((await me(a.request)).user).toMatchObject({ favoritesReceived: 1, points: 3 });
      expect((await me(b.request)).rules.favoritesEnabled).toBe(false);
    });

    it("お気に入りに選ばれた写真を削除すると、お気に入りが外れてポイントと選んだ人の枠が戻る", async () => {
      const { a, b, photoA1, admin } = await setup();
      const c = await participant("佐藤");
      await b.request("PUT", `/api/photos/${photoA1}/favorite`);
      await c.request("PUT", `/api/photos/${photoA1}/favorite`);
      expect((await me(a.request)).user).toMatchObject({ favoritesReceived: 2, points: 4 });

      expect((await admin("DELETE", `/api/admin/photos/${photoA1}`)).status).toBe(200);
      expect((await me(a.request)).user).toMatchObject({ approvedCount: 1, favoritesReceived: 0, points: 1 });
      expect((await me(b.request)).user.favoritesGiven).toBe(0);
      expect((await me(c.request)).user.favoritesGiven).toBe(0);
    });

    it("ランキングは高い順に並び、累計の推移の最後がユーザ管理のポイントと一致する", async () => {
      const { a, b, photoA1, photoA2, admin } = await setup();
      const c = await participant("佐藤");
      await b.request("PUT", `/api/photos/${photoA1}/favorite`);
      await c.request("PUT", `/api/photos/${photoA1}/favorite`);
      await c.request("PUT", `/api/photos/${photoA2}/favorite`);
      // 外したお気に入りは推移にも入らない
      await c.request("DELETE", `/api/photos/${photoA2}/favorite`);

      const res = await admin("GET", "/api/admin/ranking");
      expect(res.status).toBe(200);
      expect(
        res.body.ranking.map((r: any) => [r.rank, r.name, r.displayName.endsWith(`〉${r.name}`), r.points]),
      ).toEqual([
        [1, "田中", true, 4],
        [2, "鈴木", true, 1],
        [3, "佐藤", true, 0],
      ]);
      const users = (await admin("GET", "/api/admin/users")).body.users;
      for (const entry of res.body.ranking) {
        const history = entry.history as { at: string; points: number }[];
        expect(history[0]!.points).toBe(0);
        expect(history.at(-1)).toEqual({ at: res.body.generatedAt, points: entry.points });
        expect(entry.points).toBe(users.find((u: any) => u.userId === entry.userId).points);
        // 時刻は古い順
        expect(history.map((h) => h.at)).toEqual(history.map((h) => h.at).toSorted());
      }
      // 田中: 写真 2 枚と選ばれた 2 件で、最後の点の前に 4 に達している
      expect(res.body.ranking[0].history.at(-2).points).toBe(4);
      expect(res.body.ranking[0].userId).toBe(a.userId);
      expect(res.body.ranking[1].userId).toBe(b.userId);
    });

    it("ランキングは管理者のログインが必要", async () => {
      const { a } = await setup();
      expect((await a.request("GET", "/api/admin/ranking")).status).toBe(401);
    });

    it("お気に入りの操作は参加者のログインが必要", async () => {
      const { photoA1 } = await setup();
      expect((await createClient(app)("PUT", `/api/photos/${photoA1}/favorite`)).status).toBe(401);
    });
  });

  describe("クイズ", () => {
    let participantSeq = 0;
    async function participant(name: string) {
      const token = await issueToken();
      epithetSeq = [1, participantSeq++];
      const request = createClient(app);
      const reg = await request("POST", "/api/auth/register", { token, name });
      return { request, userId: reg.body.user.userId as string };
    }

    async function adminClient() {
      const request = createClient(app);
      await request("POST", "/api/admin/login", { password: ADMIN_PASSWORD });
      return request;
    }

    const me = async (request: ReturnType<typeof createClient>) => (await request("GET", "/api/me")).body;

    async function createQuiz(admin: ReturnType<typeof createClient>, points = [10, 0, 5]) {
      const res = await admin("POST", "/api/admin/quizzes", {
        text: "  幹事の出身地は？\n（ヒント: 海がある）  ",
        choices: points.map((p, i) => ({ text: `選択肢${i + 1}`, points: p })),
      });
      expect(res.status).toBe(201);
      return res.body.quiz;
    }

    it("出題 → 回答（選び直し可）→ 締め切りで、選んだ選択肢の点数がポイントに加わる", async () => {
      const admin = await adminClient();
      const a = await participant("田中");
      const b = await participant("鈴木");
      const quiz = await createQuiz(admin);
      expect(quiz).toMatchObject({ status: "draft", text: "幹事の出身地は？\n（ヒント: 海がある）", answerCount: 0 });
      const [c1, c2, c3] = quiz.choices.map((ch: any) => ch.choiceId);

      // 下書きは参加者に見えず、答えられない
      expect((await a.request("GET", "/api/quiz/current")).body.quiz).toBeNull();
      expect((await a.request("PUT", `/api/quiz/${quiz.quizId}/answer`, { choiceId: c1 })).body.error).toBe(
        "quiz_closed",
      );

      expect((await admin("POST", `/api/admin/quizzes/${quiz.quizId}/open`)).body.quiz.status).toBe("open");
      const current = (await a.request("GET", "/api/quiz/current")).body.quiz;
      expect(current).toEqual({
        quizId: quiz.quizId,
        text: quiz.text,
        // 正解がわからないよう、点数は返さない
        choices: quiz.choices.map((ch: any) => ({ choiceId: ch.choiceId, text: ch.text })),
      });

      expect((await a.request("PUT", `/api/quiz/${quiz.quizId}/answer`, { choiceId: c1 })).status).toBe(200);
      const changed = await a.request("PUT", `/api/quiz/${quiz.quizId}/answer`, { choiceId: c3 });
      expect(changed.body.quiz.myChoiceId).toBe(c3);
      await b.request("PUT", `/api/quiz/${quiz.quizId}/answer`, { choiceId: c2 });
      expect((await a.request("GET", "/api/quiz/current")).body.quiz.myChoiceId).toBe(c3);
      expect((await a.request("PUT", `/api/quiz/${quiz.quizId}/answer`, { choiceId: "nope" })).status).toBe(400);

      // 出題中は点数に数えない（選び直して正解を探れないように）
      expect((await me(a.request)).user).toMatchObject({ quizAnswered: 1, quizPoints: 0, points: 0 });

      expect((await admin("POST", `/api/admin/quizzes/${quiz.quizId}/close`)).status).toBe(200);
      expect((await a.request("GET", "/api/quiz/current")).body.quiz).toBeNull();
      expect((await a.request("PUT", `/api/quiz/${quiz.quizId}/answer`, { choiceId: c1 })).body.error).toBe(
        "quiz_closed",
      );
      expect((await me(a.request)).user).toMatchObject({ quizAnswered: 1, quizPoints: 5, points: 5 });
      expect((await me(b.request)).user).toMatchObject({ quizAnswered: 1, quizPoints: 0, points: 0 });

      const results = (await admin("GET", `/api/admin/quizzes/${quiz.quizId}`)).body;
      expect(results.quiz.answerCount).toBe(2);
      expect(results.quiz.choices.map((ch: any) => [ch.points, ch.answerCount])).toEqual([
        [10, 0],
        [0, 1],
        [5, 1],
      ]);
      expect(results.answers.map((x: any) => [x.displayName.endsWith("田中"), x.choiceId])).toEqual([
        [true, c3],
        [false, c2],
      ]);
      const users = (await admin("GET", "/api/admin/users")).body.users;
      expect(users.map((u: any) => [u.name, u.quizAnswered, u.quizPoints, u.points])).toEqual([
        ["田中", 1, 5, 5],
        ["鈴木", 1, 0, 0],
      ]);
    });

    it("出題中にできるのは 1 問だけで、締め切った問題は出し直せない", async () => {
      const admin = await adminClient();
      const q1 = await createQuiz(admin);
      const q2 = await createQuiz(admin);
      await admin("POST", `/api/admin/quizzes/${q1.quizId}/open`);
      expect((await admin("POST", `/api/admin/quizzes/${q2.quizId}/open`)).status).toBe(409);
      expect((await admin("POST", `/api/admin/quizzes/${q2.quizId}/close`)).status).toBe(409);
      await admin("POST", `/api/admin/quizzes/${q1.quizId}/close`);
      expect((await admin("POST", `/api/admin/quizzes/${q1.quizId}/open`)).status).toBe(409);
      expect((await admin("POST", `/api/admin/quizzes/${q2.quizId}/open`)).status).toBe(200);
      // 出題中の問題があっても、無い問題は 404
      expect((await admin("POST", "/api/admin/quizzes/NOPE/open")).status).toBe(404);
      const list = (await admin("GET", "/api/admin/quizzes")).body.quizzes;
      expect(list.map((q: any) => q.status)).toEqual(["closed", "open"]);
    });

    it("出題後も文言と点数は直せて、点数を直すと数え直す。選択肢の増減は下書きの間だけ", async () => {
      const admin = await adminClient();
      const a = await participant("田中");
      const quiz = await createQuiz(admin);
      const [c1, c2, c3] = quiz.choices.map((ch: any) => ch.choiceId);

      // 下書きなら選択肢を増やせる
      const added = await admin("PUT", `/api/admin/quizzes/${quiz.quizId}`, {
        text: quiz.text,
        choices: [
          ...quiz.choices.map((ch: any) => ({ choiceId: ch.choiceId, text: ch.text, points: ch.points })),
          { text: "選択肢4", points: 1 },
        ],
      });
      expect(added.body.quiz.choices).toHaveLength(4);

      await admin("POST", `/api/admin/quizzes/${quiz.quizId}/open`);
      await a.request("PUT", `/api/quiz/${quiz.quizId}/answer`, { choiceId: c1 });
      await admin("POST", `/api/admin/quizzes/${quiz.quizId}/close`);
      expect((await me(a.request)).user.points).toBe(10);

      const kept = added.body.quiz.choices.map((ch: any) => ({
        choiceId: ch.choiceId,
        text: ch.text,
        points: ch.points,
      }));
      const removed = await admin("PUT", `/api/admin/quizzes/${quiz.quizId}`, {
        text: quiz.text,
        choices: kept.slice(0, 3),
      });
      expect(removed.status).toBe(409);
      const unknown = await admin("PUT", `/api/admin/quizzes/${quiz.quizId}`, {
        text: quiz.text,
        choices: [...kept.slice(0, 3), { choiceId: "NOPE", text: "x", points: 0 }],
      });
      expect(unknown.status).toBe(400);
      const duplicated = await admin("PUT", `/api/admin/quizzes/${quiz.quizId}`, {
        text: quiz.text,
        choices: [kept[0], kept[0], kept[1], kept[2]],
      });
      expect(duplicated.status).toBe(400);

      const rescored = await admin("PUT", `/api/admin/quizzes/${quiz.quizId}`, {
        text: "直した問題文",
        choices: kept.map((ch: any) => (ch.choiceId === c1 ? { ...ch, text: "直した選択肢", points: 3 } : ch)),
      });
      expect(rescored.status).toBe(200);
      expect(rescored.body.quiz).toMatchObject({ text: "直した問題文", status: "closed" });
      expect((await me(a.request)).user).toMatchObject({ quizPoints: 3, points: 3 });
      expect([c2, c3]).toHaveLength(2);
    });

    it("出題中は削除できず、締め切った問題を削除すると回答と点数も消える", async () => {
      const admin = await adminClient();
      const a = await participant("田中");
      const quiz = await createQuiz(admin);
      await admin("POST", `/api/admin/quizzes/${quiz.quizId}/open`);
      await a.request("PUT", `/api/quiz/${quiz.quizId}/answer`, { choiceId: quiz.choices[0].choiceId });
      expect((await admin("DELETE", `/api/admin/quizzes/${quiz.quizId}`)).status).toBe(409);
      await admin("POST", `/api/admin/quizzes/${quiz.quizId}/close`);
      expect((await me(a.request)).user).toMatchObject({ quizAnswered: 1, points: 10 });

      expect((await admin("DELETE", `/api/admin/quizzes/${quiz.quizId}`)).status).toBe(200);
      expect((await me(a.request)).user).toMatchObject({ quizAnswered: 0, quizPoints: 0, points: 0 });
      expect((await admin("GET", "/api/admin/quizzes")).body.quizzes).toEqual([]);
      expect((await admin("DELETE", `/api/admin/quizzes/${quiz.quizId}`)).status).toBe(404);
    });

    it("ポイントを伏せている間は、参加者にクイズの点数を返さない", async () => {
      const admin = await adminClient();
      const a = await participant("田中");
      const quiz = await createQuiz(admin);
      await admin("POST", `/api/admin/quizzes/${quiz.quizId}/open`);
      await a.request("PUT", `/api/quiz/${quiz.quizId}/answer`, { choiceId: quiz.choices[0].choiceId });
      await admin("POST", `/api/admin/quizzes/${quiz.quizId}/close`);
      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, showPoints: false });

      const user = (await me(a.request)).user;
      expect(user.quizAnswered).toBe(1);
      expect(user).not.toHaveProperty("quizPoints");
      expect(user).not.toHaveProperty("points");
      const users = (await admin("GET", "/api/admin/users")).body.users;
      expect(users[0]).toMatchObject({ quizPoints: 10, points: 10 });
    });

    it("入力の検証とログインの確認", async () => {
      const admin = await adminClient();
      const bad = (body: unknown) => admin("POST", "/api/admin/quizzes", body);
      expect((await bad({ text: "問題", choices: [{ text: "1つだけ", points: 1 }] })).status).toBe(400);
      expect(
        (
          await bad({
            text: " ",
            choices: [
              { text: "a", points: 1 },
              { text: "b", points: 0 },
            ],
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await bad({
            text: "問題",
            choices: [
              { text: "a", points: 101 },
              { text: "b", points: 0 },
            ],
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await bad({
            text: "問題",
            choices: [
              { choiceId: "X", text: "a", points: 1 },
              { text: "b", points: 0 },
            ],
          })
        ).status,
      ).toBe(400);
      expect((await createClient(app)("GET", "/api/quiz/current")).status).toBe(401);
      expect((await createClient(app)("GET", "/api/admin/quizzes")).status).toBe(401);
    });
  });

  describe("取り込み（ingestUpload）", () => {
    async function activeUser() {
      const token = await issueToken();
      const reg = await createClient(app)("POST", "/api/auth/register", { token, name: "田中" });
      return reg.body.user.userId as string;
    }

    it("対象外のキーは無視する", async () => {
      expect(await ingestUpload({ repo, storage }, "uploads/ID1/thumb.jpg")).toBe("ignored");
      expect(await ingestUpload({ repo, storage }, "photos/pending/ID1/full.jpg")).toBe("ignored");
      expect(await ingestUpload({ repo, storage }, "photos/approved/ID1/full.jpg")).toBe("ignored");
      expect(await ingestUpload({ repo, storage }, "other/file.jpg")).toBe("ignored");
    });

    it("サムネイルが無い・アップロード者が一致しない・ユーザが無効なら無視する", async () => {
      const userId = await activeUser();
      storage.put(photoKey("uploads", "P1", "full"), new Uint8Array([1]), userId);
      expect(await ingestUpload({ repo, storage }, photoKey("uploads", "P1", "full"))).toBe("ignored");

      storage.put(photoKey("uploads", "P1", "thumb"), new Uint8Array([1]), "someone-else");
      expect(await ingestUpload({ repo, storage }, photoKey("uploads", "P1", "full"))).toBe("ignored");

      storage.put(photoKey("uploads", "P2", "full"), new Uint8Array([1]), "ghost");
      storage.put(photoKey("uploads", "P2", "thumb"), new Uint8Array([1]), "ghost");
      expect(await ingestUpload({ repo, storage }, photoKey("uploads", "P2", "full"))).toBe("ignored");
    });

    it("同じイベントが重複して届いてもカウンタは 1 回だけ増える", async () => {
      const userId = await activeUser();
      storage.put(photoKey("uploads", "P1", "full"), new Uint8Array([1]), userId);
      storage.put(photoKey("uploads", "P1", "thumb"), new Uint8Array([1]), userId);
      expect(await ingestUpload({ repo, storage }, photoKey("uploads", "P1", "full"))).toBe("created");
      expect(await ingestUpload({ repo, storage }, photoKey("uploads", "P1", "full"))).toBe("duplicate");
      expect((await repo.getUser(userId))!.uploadCount).toBe(1);
    });
  });
});

describe("scoreQuizAnswers", () => {
  const quiz = {
    quizId: "Q1",
    text: "問題",
    choices: [
      { choiceId: "A", text: "a", points: 10 },
      { choiceId: "B", text: "b", points: 0 },
    ],
    status: "closed" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closedAt: "2026-01-01T00:10:00.000Z",
  };

  it("締め切り後に保存された回答と、削除されたクイズへの回答は数えない", () => {
    const answer = (quizId: string, answeredAt: string) => ({ quizId, userId: "u1", choiceId: "A", answeredAt });
    expect(scoreQuizAnswers([answer("Q1", "2026-01-01T00:09:59.999Z")], [quiz])).toEqual({ answered: 1, points: 10 });
    expect(scoreQuizAnswers([answer("Q1", "2026-01-01T00:10:00.001Z")], [quiz])).toEqual({ answered: 1, points: 0 });
    expect(scoreQuizAnswers([answer("GONE", "2026-01-01T00:01:00.000Z")], [quiz])).toEqual({ answered: 0, points: 0 });
  });
});

describe("buildRanking", () => {
  const user = (userId: string, name: string, counts: Partial<UserRecord> = {}): UserRecord => ({
    userId,
    name,
    epithet: "疾風の魔術師",
    status: "active",
    uploadCount: 0,
    approvedCount: 0,
    favoritesGiven: 0,
    favoritesReceived: 0,
    createdAt: `2026-01-01T00:00:0${userId.slice(1)}.000Z`,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...counts,
  });
  const quiz = {
    quizId: "Q1",
    text: "問題",
    choices: [
      { choiceId: "A", text: "a", points: 10 },
      { choiceId: "B", text: "b", points: 0 },
    ],
    status: "closed" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closedAt: "2026-01-01T02:00:00.000Z",
  };
  const photo = (photoId: string, uploaderId: string, createdAt: string, reviewedAt?: string) => ({
    photoId,
    uploaderId,
    status: "approved" as const,
    favoriteCount: 0,
    createdAt,
    reviewedAt,
  });

  it("写真は公開した時刻、お気に入りは選ばれた時刻、クイズは締め切った時刻に加え、同じ時刻はまとめる", () => {
    const result = buildRanking({
      users: [
        user("u1", "田中", { approvedCount: 2, favoritesReceived: 1 }),
        user("u2", "鈴木", { approvedCount: 0 }),
        user("u3", "佐藤", { approvedCount: 1 }),
      ],
      settings: { ...DEFAULT_SETTINGS, uploadPoints: 2, favoritePoints: 3 },
      quizzes: [
        {
          quiz,
          answers: [
            { quizId: "Q1", userId: "u2", choiceId: "A", answeredAt: "2026-01-01T01:59:00.000Z" },
            { quizId: "Q1", userId: "u3", choiceId: "B", answeredAt: "2026-01-01T01:59:00.000Z" },
          ],
        },
        // 出題中のクイズは数えない
        {
          quiz: { ...quiz, quizId: "Q2", status: "open" as const, closedAt: undefined },
          answers: [{ quizId: "Q2", userId: "u1", choiceId: "A", answeredAt: "2026-01-01T02:30:00.000Z" }],
        },
      ],
      photos: [
        // 事前確認は承認した時刻
        photo("P1", "u1", "2026-01-01T00:10:00.000Z", "2026-01-01T00:20:00.000Z"),
        // 事後確認は投稿した時刻
        photo("P2", "u1", "2026-01-01T00:20:00.000Z"),
        photo("P3", "u3", "2026-01-01T00:30:00.000Z"),
      ],
      favorites: [{ userId: "u2", photoId: "P2", createdAt: "2026-01-01T01:00:00.000Z" }],
      now: "2026-01-01T03:00:00.000Z",
    });

    expect(result.generatedAt).toBe("2026-01-01T03:00:00.000Z");
    expect(result.ranking.map((r) => [r.rank, r.userId, r.points])).toEqual([
      [1, "u2", 10],
      [2, "u1", 7],
      [3, "u3", 2],
    ]);
    expect(result.ranking[1]!.history).toEqual([
      { at: "2026-01-01T00:00:01.000Z", points: 0 },
      { at: "2026-01-01T00:20:00.000Z", points: 4 },
      { at: "2026-01-01T01:00:00.000Z", points: 7 },
      { at: "2026-01-01T03:00:00.000Z", points: 7 },
    ]);
    expect(result.ranking[0]!.history).toEqual([
      { at: "2026-01-01T00:00:02.000Z", points: 0 },
      { at: "2026-01-01T02:00:00.000Z", points: 10 },
      { at: "2026-01-01T03:00:00.000Z", points: 10 },
    ]);
    // 0 点の選択肢は点を増やさない
    expect(result.ranking[2]!.history.map((h) => h.points)).toEqual([0, 2, 2]);
  });

  it("同点は同じ順位で、次の順位は人数分飛ばす。同点の中は先に登録した人が上", () => {
    const result = buildRanking({
      users: [user("u3", "佐藤"), user("u1", "田中", { approvedCount: 1 }), user("u2", "鈴木", { approvedCount: 1 })],
      settings: DEFAULT_SETTINGS,
      quizzes: [],
      photos: [],
      favorites: [],
      now: "2026-01-01T03:00:00.000Z",
    });
    expect(result.ranking.map((r) => [r.rank, r.userId])).toEqual([
      [1, "u1"],
      [1, "u2"],
      [3, "u3"],
    ]);
    // 推移の元データが無くても、最後の点はユーザのカウンタから計算したポイント
    expect(result.ranking[0]!.history.at(-1)).toEqual({ at: "2026-01-01T03:00:00.000Z", points: 1 });
  });
});
