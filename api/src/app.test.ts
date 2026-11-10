import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildRanking, createApp, toParticipantRanking } from "./app.js";
import { ingestUpload } from "./ingest.js";
import { MemoryRepository } from "./memory-repository.js";
import { MemoryPhotoStorage } from "./memory-storage.js";
import { photoKey, prizeImageKey } from "./photo-storage.js";
import { DEFAULT_SETTINGS, InvalidStateError, type UserRecord } from "./repository.js";
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
        favoriteGivenPoints: 10,
        showPoints: true,
        showGamePoints: true,
        rankingVisible: false,
        rankingHideNames: false,
        rankingHidePoints: false,
        trendVisible: false,
        trendHideNames: false,
        trendHidePoints: false,
        prizesVisible: false,
        tieBreakOrder: ["upload", "favoriteGiven", "favoriteReceived", "game", "registered"],
        scheduleVisible: false,
        scheduleDate: "",
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

    it("他人の写真をお気に入りにすると、選ばれた人と選んだ人にポイントが付く。二重には数えない", async () => {
      const { a, b, photoA1 } = await setup();
      const res = await b.request("PUT", `/api/photos/${photoA1}/favorite`);
      expect(res.status).toBe(200);
      expect(res.body.photo).toMatchObject({ photoId: photoA1, favorited: true, favoriteCount: 1 });
      expect(res.body.user).toMatchObject({ favoritesGiven: 1 });
      expect((await b.request("PUT", `/api/photos/${photoA1}/favorite`)).status).toBe(200);

      expect((await me(a.request)).user).toMatchObject({ favoritesReceived: 1, points: 3 });
      // 鈴木: 写真 1 枚（1）と、お気に入りを 1 枚選んだ分（既定 10）
      expect((await me(b.request)).user).toMatchObject({ favoritesGiven: 1, points: 11 });

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

    it("お気に入りを選んだ人のポイントは設定で変えられ、外すと戻る", async () => {
      const { a, b, photoA1, admin } = await setup();
      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, moderation: "post", favoriteGivenPoints: 4 });
      await b.request("PUT", `/api/photos/${photoA1}/favorite`);
      expect((await me(b.request)).user.points).toBe(1 + 4);
      expect((await me(a.request)).user.points).toBe(2 + 1);
      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, moderation: "post", favoriteGivenPoints: 0 });
      expect((await me(b.request)).user.points).toBe(1);
      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, moderation: "post", favoriteGivenPoints: 4 });
      await b.request("DELETE", `/api/photos/${photoA1}/favorite`);
      expect((await me(b.request)).user.points).toBe(1);
      // 古い画面から favoriteGivenPoints を送らずに保存しても、今の値が残る
      const { favoriteGivenPoints: _omit, ...old } = { ...DEFAULT_SETTINGS, moderation: "post" as const };
      expect((await admin("PUT", "/api/admin/settings", old)).body.settings.favoriteGivenPoints).toBe(4);
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
        res.body.ranking.map((r: any) => [r.rank, r.name, r.displayName === `〈${r.epithet}〉${r.name}`, r.points]),
      ).toEqual([
        // 鈴木: 写真 1 枚と選んだ 1 枚（10）、佐藤: 選んだ 1 枚（外した分は入らない）、田中: 写真 2 枚と選ばれた 2 件
        [1, "鈴木", true, 11],
        [2, "佐藤", true, 10],
        [3, "田中", true, 4],
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
      expect(res.body.ranking[2].history.at(-2).points).toBe(4);
      expect(res.body.ranking[2].userId).toBe(a.userId);
      expect(res.body.ranking[0].userId).toBe(b.userId);
      // 佐藤: 選んだ時刻に 10 に上がる
      expect(res.body.ranking[1].history.map((h: any) => h.points)).toEqual([0, 10, 10]);
    });

    it("参加者のランキング・トレンドは、見せる設定のときだけ返す（既定は見せない）", async () => {
      const { a, admin } = await setup();
      expect((await a.request("GET", "/api/ranking")).status).toBe(404);
      expect((await a.request("GET", "/api/trend")).status).toBe(404);

      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, rankingVisible: true, trendVisible: true });
      const ranking = await a.request("GET", "/api/ranking");
      expect(ranking.status).toBe(200);
      expect(ranking.body).toMatchObject({ hideNames: false, hidePoints: false });
      expect(ranking.body.ranking.map((r: any) => [r.rank, r.name, r.points, r.history])).toEqual([
        [1, "田中", 2, []],
        [2, "鈴木", 1, []],
      ]);
      const trend = await a.request("GET", "/api/trend");
      expect(trend.body.ranking[0].history.at(-1).points).toBe(2);
      // ログインしていなければ見られない
      expect((await createClient(app)("GET", "/api/ranking")).status).toBe(401);
    });

    it("参加者のランキングで名前・ポイントを伏せると、名前・ID・実際の値を返さない", async () => {
      const { a, admin } = await setup();
      await admin("PUT", "/api/admin/settings", {
        ...DEFAULT_SETTINGS,
        uploadPoints: 3,
        rankingVisible: true,
        rankingHideNames: true,
        rankingHidePoints: true,
        trendVisible: true,
        trendHidePoints: true,
      });
      const ranking = (await a.request("GET", "/api/ranking")).body;
      expect(ranking).toMatchObject({ hideNames: true, hidePoints: true });
      // 田中 6 点・鈴木 3 点 → 1 位を 100 とした割合
      expect(ranking.ranking.map((r: any) => [r.rank, r.userId, r.name, r.epithet, r.displayName, r.points])).toEqual([
        [1, "r1", "???", "???", "???", 100],
        [2, "r2", "???", "???", "???", 50],
      ]);
      const text = JSON.stringify(ranking);
      expect(text).not.toContain("田中");
      expect(text).not.toContain(a.userId);

      // 名前を伏せると、登録した時刻（推移の始まり）も全員そろえる
      const hiddenTrend = await admin("PUT", "/api/admin/settings", {
        ...DEFAULT_SETTINGS,
        uploadPoints: 3,
        rankingVisible: true,
        rankingHideNames: true,
        rankingHidePoints: true,
        trendVisible: true,
        trendHideNames: true,
      });
      expect(hiddenTrend.status).toBe(200);
      const starts = (await a.request("GET", "/api/trend")).body.ranking.map((r: any) => r.history[0].at);
      expect(new Set(starts).size).toBe(1);
      await admin("PUT", "/api/admin/settings", {
        ...DEFAULT_SETTINGS,
        uploadPoints: 3,
        rankingVisible: true,
        rankingHideNames: true,
        rankingHidePoints: true,
        trendVisible: true,
        trendHidePoints: true,
      });

      // トレンドはポイントだけを伏せる（名前は見える）。推移も割合にする
      const trend = (await a.request("GET", "/api/trend")).body;
      expect(trend).toMatchObject({ hideNames: false, hidePoints: true });
      expect(trend.ranking.map((r: any) => [r.name, r.history.at(-1).points])).toEqual([
        ["田中", 100],
        ["鈴木", 50],
      ]);
    });

    it("参加者のランキングには、紐づけを解除した人を出さず、順位を付け直す", async () => {
      const { a, b, admin } = await setup();
      const c = await participant("佐藤");
      await uploadAs(c.request);
      await uploadAs(c.request);
      await uploadAs(c.request);
      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, rankingVisible: true });
      expect((await admin("POST", `/api/admin/users/${c.userId}/unbind`)).status).toBe(200);

      // 管理画面には解除した人も残る
      const all = (await admin("GET", "/api/admin/ranking")).body.ranking;
      expect(all.map((r: any) => [r.rank, r.name])).toEqual([
        [1, "佐藤"],
        [2, "田中"],
        [3, "鈴木"],
      ]);
      const ranking = (await a.request("GET", "/api/ranking")).body.ranking;
      expect(ranking.map((r: any) => [r.rank, r.name, r.points])).toEqual([
        [1, "田中", 2],
        [2, "鈴木", 1],
      ]);
      expect(b.userId).toBe(ranking[1].userId);
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

  describe("ゲーム（クイズ形式）", () => {
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
      const res = await admin("POST", "/api/admin/games", {
        format: "quiz",
        name: "第 1 問",
        description: "  幹事の出身地は？\n（ヒント: 海がある）  ",
        choices: points.map((p, i) => ({ text: `選択肢${i + 1}`, points: p })),
      });
      expect(res.status).toBe(201);
      return res.body.game;
    }
    const choicesOf = (game: any) =>
      game.choices.map((ch: any) => ({ choiceId: ch.choiceId, text: ch.text, points: ch.points }));

    it("開催 → 答える（選び直し可）→ 確定で、選んだ選択肢の点数がポイントに加わる", async () => {
      const admin = await adminClient();
      const a = await participant("田中");
      const b = await participant("鈴木");
      const quiz = await createQuiz(admin);
      expect(quiz).toMatchObject({
        format: "quiz",
        status: "draft",
        description: "幹事の出身地は？\n（ヒント: 海がある）",
        answerCount: 0,
        slots: [],
      });
      const [c1, c2, c3] = quiz.choices.map((ch: any) => ch.choiceId);
      const answer = (who: typeof a, choiceId: string) =>
        who.request("PUT", `/api/game/${quiz.gameId}/answer`, { choiceId });

      // 下書きは参加者に見えず、答えられない
      expect((await a.request("GET", "/api/game/current")).body.game).toBeNull();
      expect((await answer(a, c1)).body.error).toBe("game_closed");

      expect((await admin("POST", `/api/admin/games/${quiz.gameId}/open`)).body.game.status).toBe("open");
      const current = (await a.request("GET", "/api/game/current")).body.game;
      expect(current).toEqual({
        gameId: quiz.gameId,
        format: "quiz",
        name: "第 1 問",
        description: quiz.description,
        slots: [],
        ranks: [],
        voterPoints: 0,
        // 正解がわからないよう、点数は返さない
        choices: quiz.choices.map((ch: any) => ({ choiceId: ch.choiceId, text: ch.text })),
      });

      expect((await answer(a, c1)).status).toBe(200);
      expect((await answer(a, c3)).body.game.myChoiceId).toBe(c3);
      await answer(b, c2);
      expect((await a.request("GET", "/api/game/current")).body.game.myChoiceId).toBe(c3);
      expect((await answer(a, "NOPE")).status).toBe(400);

      // 開催中は点数に数えない（選び直して正解を探れないように）
      expect((await me(a.request)).user).toMatchObject({ gamePoints: 0, points: 0, gameAwards: [] });

      const confirmed = await admin("POST", `/api/admin/games/${quiz.gameId}/confirm`);
      expect(confirmed.body.game).toMatchObject({ status: "confirmed", answerCount: 2 });
      expect((await a.request("GET", "/api/game/current")).body.game).toBeNull();
      expect((await answer(a, c1)).body.error).toBe("game_closed");
      expect((await me(a.request)).user).toMatchObject({
        gamePoints: 5,
        points: 5,
        gameAwards: [{ gameName: "第 1 問", slotName: "選択肢3", points: 5 }],
      });
      expect((await me(b.request)).user).toMatchObject({ gamePoints: 0, points: 0 });

      const results = (await admin("GET", `/api/admin/games/${quiz.gameId}/answers`)).body;
      expect(results.game.choices.map((ch: any) => [ch.points, ch.answerCount])).toEqual([
        [10, 0],
        [0, 1],
        [5, 1],
      ]);
      expect(results.answers.map((x: any) => [x.displayName.endsWith("田中"), x.choiceId])).toEqual([
        [true, c3],
        [false, c2],
      ]);
      const users = (await admin("GET", "/api/admin/users")).body.users;
      expect(users.map((u: any) => [u.name, u.gamePoints, u.points])).toEqual([
        ["田中", 5, 5],
        ["鈴木", 0, 0],
      ]);

      // 取り消すとポイントが消え、もう一度開催すれば答え直せる（前の答えは残る）
      expect((await admin("POST", `/api/admin/games/${quiz.gameId}/unconfirm`)).body.game.status).toBe("draft");
      expect((await me(a.request)).user.points).toBe(0);
      await admin("POST", `/api/admin/games/${quiz.gameId}/open`);
      expect((await a.request("GET", "/api/game/current")).body.game.myChoiceId).toBe(c3);
      await answer(a, c1);
      await admin("POST", `/api/admin/games/${quiz.gameId}/confirm`);
      expect((await me(a.request)).user.points).toBe(10);
    });

    /** 管理画面と同じく、アップロード URL をもらって画像を置く */
    async function uploadImage(admin: ReturnType<typeof createClient>) {
      const res = await admin("POST", "/api/admin/games/image-upload", {});
      expect(res.status).toBe(200);
      storage.put(res.body.upload.fields.key, new Uint8Array([1, 2, 3]), "");
      return res.body.imageId as string;
    }
    const served = (imageId: string) => storage.get(prizeImageKey(imageId)) !== undefined;

    it("問題と選択肢に画像を付けられ、差し替え・外す・削除で古い画像を消す。参加者には署名付き URL で返す", async () => {
      const admin = await adminClient();
      const a = await participant("田中");
      const q = await uploadImage(admin);
      const c1 = await uploadImage(admin);
      const created = await admin("POST", "/api/admin/games", {
        format: "quiz",
        name: "この人は誰？",
        imageId: q,
        choices: [
          { text: "A", points: 10, imageId: c1 },
          { text: "B", points: 0 },
        ],
      });
      expect(created.status).toBe(201);
      const game = created.body.game;
      expect(game.imageId).toBe(q);
      expect(game.imageUrl).toBe(`/prizes/${q}.jpg?signed`);
      expect(game.choices.map((ch: any) => ch.imageUrl)).toEqual([`/prizes/${c1}.jpg?signed`, undefined]);
      expect([served(q), served(c1)]).toEqual([true, true]);
      expect(storage.get(prizeImageKey(q, "uploads"))).toBeUndefined();

      // 参加者には開催中だけ、画像の URL も返す
      await admin("POST", `/api/admin/games/${game.gameId}/open`);
      const current = (await a.request("GET", "/api/game/current")).body.game;
      expect(current.imageUrl).toBe(`/prizes/${q}.jpg?signed`);
      expect(current.choices.map((ch: any) => ch.imageUrl)).toEqual([`/prizes/${c1}.jpg?signed`, undefined]);

      // 問題の画像を差し替え、選択肢 A の画像を外して B に付ける
      const q2 = await uploadImage(admin);
      const c2 = await uploadImage(admin);
      const [ch1, ch2] = game.choices;
      const updated = await admin("PUT", `/api/admin/games/${game.gameId}`, {
        format: "quiz",
        name: "この人は誰？",
        imageId: q2,
        choices: [
          { choiceId: ch1.choiceId, text: "A", points: 10 },
          { choiceId: ch2.choiceId, text: "B", points: 0, imageId: c2 },
        ],
      });
      expect(updated.status).toBe(200);
      expect(updated.body.game.choices.map((ch: any) => ch.imageId)).toEqual([undefined, c2]);
      expect([served(q), served(c1), served(q2), served(c2)]).toEqual([false, false, true, true]);

      // アップロードしていない画像・ほかで使った画像は 400 で、何も変えない
      const bad = (imageId: string) =>
        admin("PUT", `/api/admin/games/${game.gameId}`, {
          format: "quiz",
          name: "この人は誰？",
          imageId,
          choices: [
            { choiceId: ch1.choiceId, text: "A", points: 10 },
            { choiceId: ch2.choiceId, text: "B", points: 0, imageId: c2 },
          ],
        });
      expect((await bad("NOTUPLOADED")).status).toBe(400);
      expect((await bad(q)).status).toBe(400);
      expect(served(q2)).toBe(true);
      // 同じ画像を 2 か所には付けられない
      expect(
        (
          await admin("PUT", `/api/admin/games/${game.gameId}`, {
            format: "quiz",
            name: "この人は誰？",
            imageId: c2,
            choices: [
              { choiceId: ch1.choiceId, text: "A", points: 10 },
              { choiceId: ch2.choiceId, text: "B", points: 0, imageId: c2 },
            ],
          })
        ).status,
      ).toBe(400);

      // 版が古ければ、新しい画像は移さずに 409（受け口に残り、1 日で消える）
      const q3 = await uploadImage(admin);
      const stale = await admin("PUT", `/api/admin/games/${game.gameId}`, {
        format: "quiz",
        name: "この人は誰？",
        imageId: q3,
        choices: [
          { choiceId: ch1.choiceId, text: "A", points: 10 },
          { choiceId: ch2.choiceId, text: "B", points: 0, imageId: c2 },
        ],
        baseUpdatedAt: game.updatedAt,
      });
      expect(stale.status).toBe(409);
      expect(served(q3)).toBe(false);

      // 画像を移した後に保存が失敗したら（同時の変更で版の条件に合わないなど）、移した画像を消す
      const q4 = await uploadImage(admin);
      const spy = vi.spyOn(repo, "updateGame").mockRejectedValueOnce(new InvalidStateError());
      const failed = await admin("PUT", `/api/admin/games/${game.gameId}`, {
        format: "quiz",
        name: "この人は誰？",
        imageId: q4,
        choices: [
          { choiceId: ch1.choiceId, text: "A", points: 10 },
          { choiceId: ch2.choiceId, text: "B", points: 0, imageId: c2 },
        ],
      });
      spy.mockRestore();
      expect(failed.status).toBe(409);
      expect([served(q4), served(q2), served(c2)]).toEqual([false, true, true]);

      // 削除すると画像も消す
      await admin("POST", `/api/admin/games/${game.gameId}/stop`);
      expect((await admin("DELETE", `/api/admin/games/${game.gameId}`)).status).toBe(200);
      expect([served(q2), served(c2)]).toEqual([false, false]);
    });

    it("開催中にできるのは 1 つだけ（形式によらない）。やめる・確定で次を開催できる", async () => {
      const admin = await adminClient();
      const q1 = await createQuiz(admin);
      const q2 = await createQuiz(admin);
      const r1 = (await admin("POST", "/api/admin/games", { format: "result", name: "大会", slots: [] })).body.game;
      const post = (id: string, action: string) =>
        admin("POST", `/api/admin/games/${id}/${action}`).then((r) => r.status);
      expect(await post(q1.gameId, "open")).toBe(200);
      expect(await post(q2.gameId, "open")).toBe(409);
      expect(await post(r1.gameId, "open")).toBe(409);
      expect(await post(q2.gameId, "stop")).toBe(409);
      expect(await post(q1.gameId, "open")).toBe(409);
      expect(await post(q1.gameId, "stop")).toBe(200);
      expect(await post(r1.gameId, "open")).toBe(200);
      expect(await post(r1.gameId, "confirm")).toBe(409); // 枠が無い
      expect(await post(q2.gameId, "confirm")).toBe(200); // 下書きから直接確定もできる
      expect(await post(q2.gameId, "confirm")).toBe(409);
      expect(await post(q2.gameId, "unconfirm")).toBe(200);
      expect(await post(q2.gameId, "unconfirm")).toBe(409);
      // 開催中のゲームがあっても、無いゲームは 404
      expect(await post("NOPE", "open")).toBe(404);
      const list = (await admin("GET", "/api/admin/games")).body.games;
      expect(list.map((g: any) => [g.format, g.status])).toEqual([
        ["quiz", "draft"],
        ["quiz", "draft"],
        ["result", "open"],
      ]);
    });

    it("開催した後も文言と点数は直せて、点数を直すと数え直す。選択肢の増減は答えが無い下書きの間だけ", async () => {
      const admin = await adminClient();
      const a = await participant("田中");
      const quiz = await createQuiz(admin);
      const [c1] = quiz.choices.map((ch: any) => ch.choiceId);
      const put = (body: Record<string, unknown>) =>
        admin("PUT", `/api/admin/games/${quiz.gameId}`, { format: "quiz", name: "第 1 問", ...body });

      // 下書きで答えが無いなら選択肢を増やせる
      const added = await put({ choices: [...choicesOf(quiz), { text: "選択肢4", points: 1 }] });
      expect(added.body.game.choices).toHaveLength(4);
      const kept = choicesOf(added.body.game);

      await admin("POST", `/api/admin/games/${quiz.gameId}/open`);
      await a.request("PUT", `/api/game/${quiz.gameId}/answer`, { choiceId: c1 });
      expect((await put({ choices: kept.slice(0, 3) })).status).toBe(409);
      await admin("POST", `/api/admin/games/${quiz.gameId}/confirm`);
      expect((await me(a.request)).user.points).toBe(10);
      // 答えがあれば、下書きに戻しても増減はできない
      await admin("POST", `/api/admin/games/${quiz.gameId}/unconfirm`);
      expect((await put({ choices: kept.slice(0, 3) })).status).toBe(409);
      await admin("POST", `/api/admin/games/${quiz.gameId}/confirm`);

      expect((await put({ choices: [...kept.slice(0, 3), { choiceId: "NOPE", text: "x", points: 0 }] })).status).toBe(
        400,
      );
      expect((await put({ choices: [kept[0], kept[0], kept[1], kept[2]] })).status).toBe(400);
      expect((await put({ format: "result", choices: [], slots: [] })).status).toBe(400);

      const rescored = await put({
        description: "直した問題文",
        choices: kept.map((ch: any) => (ch.choiceId === c1 ? { ...ch, text: "直した選択肢", points: 3 } : ch)),
      });
      expect(rescored.status).toBe(200);
      expect(rescored.body.game).toMatchObject({ description: "直した問題文", status: "confirmed" });
      expect((await me(a.request)).user).toMatchObject({
        gamePoints: 3,
        points: 3,
        gameAwards: [{ gameName: "第 1 問", slotName: "直した選択肢", points: 3 }],
      });
    });

    it("開催中は削除できず、確定したゲームを削除すると答えと点数も消える", async () => {
      const admin = await adminClient();
      const a = await participant("田中");
      const quiz = await createQuiz(admin);
      await admin("POST", `/api/admin/games/${quiz.gameId}/open`);
      await a.request("PUT", `/api/game/${quiz.gameId}/answer`, { choiceId: quiz.choices[0].choiceId });
      expect((await admin("DELETE", `/api/admin/games/${quiz.gameId}`)).status).toBe(409);
      await admin("POST", `/api/admin/games/${quiz.gameId}/confirm`);
      expect((await me(a.request)).user.points).toBe(10);

      expect((await admin("DELETE", `/api/admin/games/${quiz.gameId}`)).status).toBe(200);
      expect((await me(a.request)).user).toMatchObject({ gamePoints: 0, points: 0 });
      expect((await admin("GET", "/api/admin/games")).body.games).toEqual([]);
      expect(await repo.listGameAnswersByUser(a.userId)).toEqual([]);
      expect((await admin("DELETE", `/api/admin/games/${quiz.gameId}`)).status).toBe(404);
    });

    it("ゲームの点数は写真のポイントとは別に伏せられる", async () => {
      const admin = await adminClient();
      const a = await participant("田中");
      const quiz = await createQuiz(admin);
      await admin("POST", `/api/admin/games/${quiz.gameId}/open`);
      await a.request("PUT", `/api/game/${quiz.gameId}/answer`, { choiceId: quiz.choices[0].choiceId });
      await admin("POST", `/api/admin/games/${quiz.gameId}/confirm`);

      // ゲームの点数だけを伏せる。合計のポイント（ゲームの分を含む）は見える
      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, showGamePoints: false });
      let user = (await me(a.request)).user;
      expect(user).not.toHaveProperty("gamePoints");
      expect(user).not.toHaveProperty("gameAwards");
      expect(user.points).toBe(10);

      // 写真のポイントだけを伏せる。ゲームの点数は見える
      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, showPoints: false });
      user = (await me(a.request)).user;
      expect(user).not.toHaveProperty("points");
      expect(user.gamePoints).toBe(10);
    });

    it("入力の検証とログインの確認", async () => {
      const admin = await adminClient();
      const bad = (body: Record<string, unknown>) =>
        admin("POST", "/api/admin/games", { format: "quiz", name: "問題", ...body }).then((r) => r.status);
      const two = [
        { text: "a", points: 1 },
        { text: "b", points: 0 },
      ];
      expect(await bad({ choices: [{ text: "1つだけ", points: 1 }] })).toBe(400);
      expect(await bad({ choices: [] })).toBe(400);
      expect(await bad({ name: " ", choices: two })).toBe(400);
      expect(await bad({ choices: [{ text: "a", points: 101 }, two[1]] })).toBe(400);
      expect(await bad({ choices: [{ choiceId: "X", text: "a", points: 1 }, two[1]] })).toBe(400);
      expect(await bad({ choices: two, slots: [{ name: "優勝", points: 1, userIds: [] }] })).toBe(400);
      expect(await bad({ format: "result", choices: two })).toBe(400);
      expect(await bad({ format: "other", choices: two })).toBe(400);
      expect(await bad({ choices: two, description: "x".repeat(501) })).toBe(400);
      // 結果入力のゲームには答えられない
      const result = (await admin("POST", "/api/admin/games", { format: "result", name: "大会" })).body.game;
      await admin("POST", `/api/admin/games/${result.gameId}/open`);
      const a = await participant("田中");
      expect((await a.request("PUT", `/api/game/${result.gameId}/answer`, { choiceId: "X" })).status).toBe(400);
      expect((await createClient(app)("GET", "/api/game/current")).status).toBe(401);
      expect((await createClient(app)("GET", "/api/admin/games")).status).toBe(401);
    });
  });

  describe("ゲーム（合言葉）", () => {
    let participantSeq = 0;
    async function participant(name: string) {
      const token = await issueToken();
      epithetSeq = [4, participantSeq++];
      const request = createClient(app);
      const reg = await request("POST", "/api/auth/register", { token, name });
      return { request, userId: reg.body.user.userId as string };
    }

    async function adminClient() {
      const request = createClient(app);
      await request("POST", "/api/admin/login", { password: ADMIN_PASSWORD });
      return request;
    }

    const me = async (request: ReturnType<typeof createClient>) => (await request("GET", "/api/me")).body.user;
    const ranks = [
      { from: 1, to: 1, points: 20 },
      { from: 2, to: 3, points: 5 },
    ];

    it("開催 → 合言葉を入れる（不正解は何度でも、正解は先着順）→ 確定で、正解した順の点数が入る", async () => {
      const admin = await adminClient();
      const created = await admin("POST", "/api/admin/games", {
        format: "keyword",
        name: "宝探し",
        keyword: " パーティー ",
        ranks,
      });
      expect(created.status).toBe(201);
      const game = created.body.game;
      expect(game).toMatchObject({ format: "keyword", keyword: "パーティー", ranks });

      const people: Awaited<ReturnType<typeof participant>>[] = [];
      for (const n of ["A", "B", "C", "D", "E"]) people.push(await participant(n));
      const send = (who: (typeof people)[number], text: string) =>
        who.request("PUT", `/api/game/${game.gameId}/answer`, { text });
      expect((await send(people[0]!, "パーティー")).body.error).toBe("game_closed");

      expect((await admin("POST", `/api/admin/games/${game.gameId}/open`)).status).toBe(200);
      const current = (await people[0]!.request("GET", "/api/game/current")).body.game;
      expect(current).toMatchObject({ format: "keyword", ranks, myKeywordCorrect: false });
      // 合言葉は参加者に返さない
      expect(JSON.stringify(current)).not.toContain("パーティー");

      // 不正解は保存せず、何度でも試せる
      const wrong = await send(people[0]!, "ぱーちー");
      expect(wrong.status).toBe(200);
      expect(wrong.body).toMatchObject({ correct: false, game: { myKeywordCorrect: false } });
      expect((await people[0]!.request("PUT", `/api/game/${game.gameId}/answer`, { value: 1 })).status).toBe(400);
      expect((await people[0]!.request("PUT", `/api/game/${game.gameId}/answer`, { text: "  " })).status).toBe(400);

      // 正解した順は時刻で決まるので、1 秒ずつ進める
      let t = Date.now();
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const tick = () => {
          t += 1000;
          vi.setSystemTime(t);
        };
        // 表記の揺れは同じ言葉として扱う。正解の順: B, A, D, C（E は不正解のまま）
        tick();
        expect((await send(people[1]!, "ﾊﾟｰﾃｨｰ")).body).toMatchObject({
          correct: true,
          game: { myKeywordCorrect: true },
        });
        tick();
        await send(people[0]!, "ぱーてぃー");
        tick();
        await send(people[3]!, "パー ティー");
        tick();
        await send(people[2]!, "パーティー");
        await send(people[4]!, "違う");
        // 正解した後に送っても、最初に正解した時刻のまま
        tick();
        expect((await send(people[1]!, "パーティー")).body.correct).toBe(true);
        expect((await send(people[1]!, "違う")).body).toMatchObject({
          correct: false,
          game: { myKeywordCorrect: true },
        });
        expect((await people[1]!.request("GET", "/api/game/current")).body.game.myKeywordCorrect).toBe(true);
        expect((await me(people[1]!.request)).gamePoints).toBe(0);

        const answers = (await admin("GET", `/api/admin/games/${game.gameId}/answers`)).body.answers;
        expect(answers).toHaveLength(4);
        expect(answers[0]).toMatchObject({ userId: people[1]!.userId, text: "ﾊﾟｰﾃｨｰ" });

        tick();
        expect((await admin("POST", `/api/admin/games/${game.gameId}/confirm`)).status).toBe(200);
      } finally {
        vi.useRealTimers();
      }
      const pts = await Promise.all(people.map(async (p) => (await me(p.request)).gamePoints));
      expect(pts).toEqual([5, 20, 0, 5, 0]);
      expect((await me(people[1]!.request)).gameAwards).toEqual([
        expect.objectContaining({ gameName: "宝探し", slotName: "1 番目に正解", points: 20 }),
      ]);
      expect((await me(people[2]!.request)).gameAwards).toEqual([
        expect.objectContaining({ slotName: "4 番目に正解", points: 0 }),
      ]);

      // 確定後に合言葉を直すと、今の合言葉に合う答えだけで数え直す（B の「ﾊﾟｰﾃｨｰ」は全員同じ言葉なので変わらない）
      const latest = (await admin("GET", "/api/admin/games")).body.games.find((g: any) => g.gameId === game.gameId);
      const base = { format: "keyword", name: "宝探し", baseUpdatedAt: latest.updatedAt };
      expect((await admin("PUT", `/api/admin/games/${game.gameId}`, { ...base, keyword: "違う" })).status).toBe(409);
      const changed = await admin("PUT", `/api/admin/games/${game.gameId}`, { ...base, keyword: "違う", ranks });
      expect(changed.status).toBe(200);
      expect(await Promise.all(people.map(async (p) => (await me(p.request)).gamePoints))).toEqual([0, 0, 0, 0, 0]);
    });

    it("入力の検証と、範囲が無いと確定できないこと", async () => {
      const admin = await adminClient();
      const bad = (body: Record<string, unknown>) =>
        admin("POST", "/api/admin/games", { format: "keyword", name: "合言葉", ...body }).then((r) => r.status);
      expect(await bad({})).toBe(400);
      expect(await bad({ keyword: " " })).toBe(400);
      expect(await bad({ keyword: "x".repeat(51) })).toBe(400);
      expect(await bad({ keyword: "a", correctNumber: 1 })).toBe(400);
      expect(
        await admin("POST", "/api/admin/games", { format: "number", name: "n", keyword: "a" }).then((r) => r.status),
      ).toBe(400);
      const game = (await admin("POST", "/api/admin/games", { format: "keyword", name: "合言葉", keyword: "a" })).body
        .game;
      const res = await admin("POST", `/api/admin/games/${game.gameId}/confirm`);
      expect(res.status).toBe(409);
      expect(res.body.message).toBe("点数の範囲を追加してから確定してください");
    });
  });

  describe("ゲーム（投票）", () => {
    let participantSeq = 0;
    async function participant(name: string) {
      const token = await issueToken();
      epithetSeq = [3, participantSeq++];
      const request = createClient(app);
      const reg = await request("POST", "/api/auth/register", { token, name });
      return { request, userId: reg.body.user.userId as string };
    }

    async function adminClient() {
      const request = createClient(app);
      await request("POST", "/api/admin/login", { password: ADMIN_PASSWORD });
      return request;
    }

    const me = async (request: ReturnType<typeof createClient>) => (await request("GET", "/api/me")).body.user;
    const ranks = [
      { from: 1, to: 1, points: 30 },
      { from: 2, to: 3, points: 10 },
    ];

    it("開催 → 投票（選び直し可）→ 確定で、得票の順位に応じた点数と、投票した人の点数が入る", async () => {
      const admin = await adminClient();
      const created = await admin("POST", "/api/admin/games", { format: "vote", name: "MVP", ranks, voterPoints: 2 });
      expect(created.status).toBe(201);
      const game = created.body.game;
      expect(game).toMatchObject({ format: "vote", voterPoints: 2, ranks, choices: [], slots: [] });

      // 二つ名の抽選を順に指定するので、一人ずつ登録する
      const people: Awaited<ReturnType<typeof participant>>[] = [];
      for (const n of ["A", "B", "C", "D", "E"]) people.push(await participant(n));
      const [a, b, c, d, e] = people as [
        (typeof people)[0],
        (typeof people)[0],
        (typeof people)[0],
        (typeof people)[0],
        (typeof people)[0],
      ];
      const vote = (who: typeof a, targetUserId: string) =>
        who.request("PUT", `/api/game/${game.gameId}/answer`, { targetUserId });
      expect((await vote(a, b.userId)).body.error).toBe("game_closed");
      expect((await a.request("GET", `/api/game/${game.gameId}/candidates`)).status).toBe(409);

      // E は紐づけを解除する（候補に出ず、投票もできない）
      expect((await admin("POST", `/api/admin/users/${e.userId}/unbind`)).status).toBe(200);
      expect((await admin("POST", `/api/admin/games/${game.gameId}/open`)).status).toBe(200);
      const current = (await a.request("GET", "/api/game/current")).body.game;
      expect(current).toMatchObject({ format: "vote", ranks, voterPoints: 2 });
      expect(current.myTargetUserId).toBeUndefined();

      const candidates = (await a.request("GET", `/api/game/${game.gameId}/candidates`)).body.candidates;
      expect(candidates.map((x: any) => x.userId).sort()).toEqual([b.userId, c.userId, d.userId].sort());
      expect(candidates[0].displayName).toContain("B");

      // 自分・紐づけを解除した人・いない人・ほかの形の答えは受け付けない
      expect((await vote(a, a.userId)).status).toBe(400);
      expect((await vote(a, e.userId)).status).toBe(400);
      expect((await vote(a, "NOBODY")).status).toBe(400);
      expect((await a.request("PUT", `/api/game/${game.gameId}/answer`, { value: 1 })).status).toBe(400);

      // A → C から B に選び直す。B → C、C → B、D → A
      expect((await vote(a, c.userId)).body.game.myTargetUserId).toBe(c.userId);
      await vote(a, b.userId);
      await vote(b, c.userId);
      await vote(c, b.userId);
      await vote(d, a.userId);
      expect((await a.request("GET", "/api/game/current")).body.game.myTargetUserId).toBe(b.userId);
      // 開催中は数えない
      expect((await me(b.request)).gamePoints).toBe(0);

      const answers = (await admin("GET", `/api/admin/games/${game.gameId}/answers`)).body.answers;
      expect(answers.find((x: any) => x.userId === a.userId)).toMatchObject({ targetUserId: b.userId });
      expect(answers.find((x: any) => x.userId === a.userId).targetDisplayName).toContain("B");

      expect((await admin("POST", `/api/admin/games/${game.gameId}/confirm`)).status).toBe(200);
      // B 2 票 1 位 30 点、C 1 票・A 1 票は 2 位 10 点。投票した 4 人に 2 点ずつ
      const pts = await Promise.all([a, b, c, d].map(async (p) => (await me(p.request)).gamePoints));
      expect(pts).toEqual([12, 32, 12, 2]);
      expect((await me(b.request)).gameAwards).toEqual([
        expect.objectContaining({ gameName: "MVP", slotName: "1 位（2 票）", points: 30 }),
        expect.objectContaining({ gameName: "MVP", slotName: "投票", points: 2 }),
      ]);
      // ランキングにも入る（D は投票していないが、選ばれた分は参加者の画面でも数える）
      const ranking = (await admin("GET", "/api/admin/ranking")).body.ranking;
      expect(Object.fromEntries(ranking.map((x: any) => [x.name, x.points]))).toMatchObject({
        A: 12,
        B: 32,
        C: 12,
        D: 2,
      });

      // 確定後に点数を直すと数え直す。範囲を全部外すのは受け付けない
      const latest = (await admin("GET", "/api/admin/games")).body.games.find((g: any) => g.gameId === game.gameId);
      const base = { format: "vote", name: "MVP", baseUpdatedAt: latest.updatedAt };
      expect((await admin("PUT", `/api/admin/games/${game.gameId}`, { ...base, voterPoints: 2 })).status).toBe(409);
      expect(
        (await admin("PUT", `/api/admin/games/${game.gameId}`, { ...base, ranks: [{ from: 1, to: 2, points: 5 }] }))
          .status,
      ).toBe(200);
      expect(await Promise.all([a, b, c, d].map(async (p) => (await me(p.request)).gamePoints))).toEqual([5, 5, 5, 0]);
    });

    it("入力の検証と、範囲が無いと確定できないこと", async () => {
      const admin = await adminClient();
      const bad = (body: Record<string, unknown>) =>
        admin("POST", "/api/admin/games", { format: "vote", name: "投票", ...body }).then((r) => r.status);
      expect(await bad({ correctNumber: 1 })).toBe(400);
      expect(await bad({ voterPoints: 101 })).toBe(400);
      expect(await bad({ ranks: [{ from: 2, to: 1, points: 1 }] })).toBe(400);
      expect(
        await admin("POST", "/api/admin/games", { format: "quiz", name: "q", voterPoints: 1 }).then((r) => r.status),
      ).toBe(400);
      const game = (await admin("POST", "/api/admin/games", { format: "vote", name: "投票" })).body.game;
      expect(game.voterPoints).toBe(0);
      const res = await admin("POST", `/api/admin/games/${game.gameId}/confirm`);
      expect(res.status).toBe(409);
      expect(res.body.message).toBe("点数の範囲を追加してから確定してください");
      const a = await participant("田中");
      expect((await a.request("GET", `/api/game/${game.gameId}/candidates`)).status).toBe(409);
      const quiz = (
        await admin("POST", "/api/admin/games", {
          format: "quiz",
          name: "q",
          choices: [
            { text: "a", points: 1 },
            { text: "b", points: 0 },
          ],
        })
      ).body.game;
      expect((await a.request("GET", `/api/game/${quiz.gameId}/candidates`)).status).toBe(400);
    });
  });

  describe("ゲーム（数値予想）", () => {
    let participantSeq = 0;
    async function participant(name: string) {
      const token = await issueToken();
      epithetSeq = [2, participantSeq++];
      const request = createClient(app);
      const reg = await request("POST", "/api/auth/register", { token, name });
      return { request, userId: reg.body.user.userId as string };
    }

    async function adminClient() {
      const request = createClient(app);
      await request("POST", "/api/admin/login", { password: ADMIN_PASSWORD });
      return request;
    }

    const me = async (request: ReturnType<typeof createClient>) => (await request("GET", "/api/me")).body.user;
    const ranks = [
      { from: 3, to: 5, points: 3 },
      { from: 1, to: 2, points: 10 },
    ];

    it("開催 → 数を答える（答え直し可）→ 正解の数を入れて確定で、近い順の順位に応じた点数が入る", async () => {
      const admin = await adminClient();
      const created = await admin("POST", "/api/admin/games", {
        format: "number",
        name: "瓶の中の飴は何個？",
        ranks,
      });
      expect(created.status).toBe(201);
      const game = created.body.game;
      // 点数の範囲は順位の小さい順に並べ直す
      expect(game).toMatchObject({ format: "number", status: "draft", ranks: [ranks[1], ranks[0]], choices: [] });
      expect(game.correctNumber).toBeUndefined();

      // 二つ名の抽選を順に指定するので、一人ずつ登録する
      const people: Awaited<ReturnType<typeof participant>>[] = [];
      for (const n of ["A", "B", "C", "D", "E", "F", "G"]) people.push(await participant(n));
      const answer = (who: (typeof people)[number], body: unknown) =>
        who.request("PUT", `/api/game/${game.gameId}/answer`, body);
      expect((await answer(people[0]!, { value: 50 })).body.error).toBe("game_closed");

      expect((await admin("POST", `/api/admin/games/${game.gameId}/open`)).status).toBe(200);
      const current = (await people[0]!.request("GET", "/api/game/current")).body.game;
      expect(current).toMatchObject({ format: "number", ranks: [ranks[1], ranks[0]] });
      // 正解の数は参加者に返さない
      expect(current).not.toHaveProperty("correctNumber");

      // 範囲の外・小数・選択肢での答えは受け付けない
      for (const body of [
        { value: -1 },
        { value: 101 },
        { value: 1.5 },
        { choiceId: "X" },
        {},
        { value: 1, choiceId: "X" },
      ]) {
        expect((await answer(people[0]!, body)).status).toBe(400);
      }
      // 正解 40 に対して: A 0 → 40, B 30 → 10, C 50 → 10, D 45 → 5, E 40 → 0, F 100 → 60, G 70 → 30
      const values = [0, 30, 50, 45, 40, 100, 70];
      expect((await answer(people[0]!, { value: 99 })).body.game.myValue).toBe(99);
      for (const [i, v] of values.entries()) expect((await answer(people[i]!, { value: v })).status).toBe(200);
      expect((await people[0]!.request("GET", "/api/game/current")).body.game.myValue).toBe(0);

      // 正解の数が無いうちは確定できない
      const noAnswer = await admin("POST", `/api/admin/games/${game.gameId}/confirm`);
      expect(noAnswer.status).toBe(409);
      expect(noAnswer.body.message).toBe("正解の数を入れてから確定してください");

      const list = (await admin("GET", "/api/admin/games")).body.games.find((g: any) => g.gameId === game.gameId);
      const set = await admin("PUT", `/api/admin/games/${game.gameId}`, {
        format: "number",
        name: game.name,
        ranks,
        correctNumber: 40,
        baseUpdatedAt: list.updatedAt,
      });
      expect(set.status).toBe(200);
      expect(set.body.game.correctNumber).toBe(40);
      expect((await admin("POST", `/api/admin/games/${game.gameId}/confirm`)).status).toBe(200);

      const answers = (await admin("GET", `/api/admin/games/${game.gameId}/answers`)).body.answers;
      expect(answers.map((x: any) => x.value).sort((x: number, y: number) => x - y)).toEqual(
        [...values].sort((x, y) => x - y),
      );

      // 順位: E 1 位, D 2 位, B・C 3 位（同じ距離は同じ順位）, G 5 位, A 6 位, F 7 位
      const pts = await Promise.all(people.map(async (p) => (await me(p.request)).gamePoints));
      expect(pts).toEqual([0, 3, 3, 10, 10, 0, 3]);
      expect((await me(people[1]!.request)).gameAwards).toEqual([
        expect.objectContaining({ gameName: game.name, slotName: "3 位（予想 30）", points: 3 }),
      ]);

      // 確定後に正解の数を直すと、ポイントも直る（正解 100 なら F が 1 位）
      const after = (await admin("GET", "/api/admin/games")).body.games.find((g: any) => g.gameId === game.gameId);
      await admin("PUT", `/api/admin/games/${game.gameId}`, {
        format: "number",
        name: game.name,
        ranks,
        correctNumber: 100,
        baseUpdatedAt: after.updatedAt,
      });
      expect((await me(people[5]!.request)).gamePoints).toBe(10);
      expect((await me(people[0]!.request)).gamePoints).toBe(0);

      // 確定したまま正解の数や点数の範囲を外すと、入ったポイントが黙って消えるので受け付けない
      const latest = (await admin("GET", "/api/admin/games")).body.games.find((g: any) => g.gameId === game.gameId);
      const base = { format: "number", name: game.name, baseUpdatedAt: latest.updatedAt };
      expect((await admin("PUT", `/api/admin/games/${game.gameId}`, { ...base, ranks })).status).toBe(409);
      expect((await admin("PUT", `/api/admin/games/${game.gameId}`, { ...base, correctNumber: 100 })).status).toBe(409);
      expect((await me(people[5]!.request)).gamePoints).toBe(10);
      // ランキングにも入る（全員の答えから順位を付ける）
      const ranking = (await admin("GET", "/api/admin/ranking")).body.ranking;
      const pointsByName = Object.fromEntries(ranking.map((e: any) => [e.name, e.points]));
      // 正解 100 との差: F 0, G 30, C 50, D 55, E 60, B 70, A 100 → 1〜2 位 10 点、3〜5 位 3 点
      expect(pointsByName).toEqual({ A: 0, B: 0, C: 3, D: 3, E: 3, F: 10, G: 10 });
    });

    it("点数の範囲が無いと確定できず、範囲の重なりや逆転は受け付けない", async () => {
      const admin = await adminClient();
      const bad = (body: Record<string, unknown>) =>
        admin("POST", "/api/admin/games", { format: "number", name: "数", ...body }).then((r) => r.status);
      expect(await bad({ ranks: [{ from: 3, to: 1, points: 1 }] })).toBe(400);
      expect(
        await bad({
          ranks: [
            { from: 1, to: 3, points: 5 },
            { from: 3, to: 5, points: 1 },
          ],
        }),
      ).toBe(400);
      expect(await bad({ ranks: [{ from: 0, to: 1, points: 1 }] })).toBe(400);
      expect(await bad({ correctNumber: 101 })).toBe(400);
      expect(await bad({ correctNumber: 1.5 })).toBe(400);
      expect(
        await bad({
          choices: [
            { text: "a", points: 1 },
            { text: "b", points: 0 },
          ],
        }),
      ).toBe(400);
      expect(await admin("POST", "/api/admin/games", { format: "quiz", name: "q", ranks }).then((r) => r.status)).toBe(
        400,
      );

      const game = (await admin("POST", "/api/admin/games", { format: "number", name: "数", correctNumber: 0 })).body
        .game;
      expect(game.correctNumber).toBe(0);
      const res = await admin("POST", `/api/admin/games/${game.gameId}/confirm`);
      expect(res.status).toBe(409);
      expect(res.body.message).toBe("点数の範囲を追加してから確定してください");
    });
  });

  describe("景品", () => {
    async function adminClient() {
      const request = createClient(app);
      await request("POST", "/api/admin/login", { password: ADMIN_PASSWORD });
      return request;
    }

    async function participant() {
      const token = await issueToken();
      const request = createClient(app);
      await request("POST", "/api/auth/register", { token, name: "参加者" });
      return request;
    }

    /** 管理画面と同じく、アップロード URL をもらって画像を置く */
    async function uploadImage(admin: ReturnType<typeof createClient>) {
      const res = await admin("POST", "/api/admin/prizes/image-upload", {});
      expect(res.status).toBe(200);
      storage.put(res.body.upload.fields.key, new Uint8Array([1, 2, 3]), "");
      return res.body.imageId as string;
    }

    /** 配信する領域に画像があるか */
    const served = (imageId: string) => storage.get(prizeImageKey(imageId)) !== undefined;

    it("登録・更新・削除ができ、順位は小さい順に並べ、画像は署名付き URL で返す", async () => {
      const admin = await adminClient();
      const imageId = await uploadImage(admin);
      const created = await admin("POST", "/api/admin/prizes", {
        name: "  ＴＶ  ",
        quantity: 3,
        positions: [3, 1],
        imageId,
      });
      expect(created.status).toBe(201);
      expect(created.body.prize).toMatchObject({
        name: "TV",
        quantity: 3,
        positions: [1, 3],
        imageUrl: `/prizes/${imageId}.jpg?signed`,
      });
      const prizeId = created.body.prize.prizeId;
      // 受け口から配信する領域へ移している
      expect(served(imageId)).toBe(true);
      expect(storage.get(prizeImageKey(imageId, "uploads"))).toBeUndefined();

      // 別の景品は同じ順位にも割り当てられ、画像なしでもよい
      const other = await admin("POST", "/api/admin/prizes", { name: "お菓子", quantity: 10, positions: [1, 2] });
      expect(other.status).toBe(201);
      expect(other.body.prize.imageUrl).toBeUndefined();

      const list = await admin("GET", "/api/admin/prizes");
      expect(list.body.prizes.map((p: any) => [p.name, p.positions])).toEqual([
        ["TV", [1, 3]],
        ["お菓子", [1, 2]],
      ]);

      // 画像を差し替えると古い画像を消す
      const newImageId = await uploadImage(admin);
      const updated = await admin("PUT", `/api/admin/prizes/${prizeId}`, {
        name: "テレビ",
        quantity: 2,
        positions: [2],
        imageId: newImageId,
      });
      expect(updated.status).toBe(200);
      expect(updated.body.prize).toMatchObject({ name: "テレビ", quantity: 2, positions: [2] });
      expect(served(imageId)).toBe(false);
      expect(served(newImageId)).toBe(true);

      // 画像を外しても消す
      const removed = await admin("PUT", `/api/admin/prizes/${prizeId}`, {
        name: "テレビ",
        quantity: 2,
        positions: [],
      });
      expect(removed.body.prize.imageUrl).toBeUndefined();
      expect(served(newImageId)).toBe(false);

      // 削除すると画像も消す
      const thirdImage = await uploadImage(admin);
      await admin("PUT", `/api/admin/prizes/${prizeId}`, {
        name: "テレビ",
        quantity: 2,
        positions: [],
        imageId: thirdImage,
      });
      expect((await admin("DELETE", `/api/admin/prizes/${prizeId}`)).status).toBe(200);
      expect(served(thirdImage)).toBe(false);
      expect((await admin("GET", "/api/admin/prizes")).body.prizes.map((p: any) => p.name)).toEqual(["お菓子"]);
      // 差し替え・外す・削除のたびに、CloudFront のキャッシュも消している
      expect(storage.removedPrizeImages).toEqual([imageId, newImageId, thirdImage]);
      expect((await admin("DELETE", `/api/admin/prizes/${prizeId}`)).status).toBe(404);
      expect(
        (await admin("PUT", `/api/admin/prizes/${prizeId}`, { name: "x", quantity: 1, positions: [] })).status,
      ).toBe(404);
    });

    it("数量を超える割り当て・重複した順位・アップロードしていない画像・他の景品の画像は 400", async () => {
      const admin = await adminClient();
      const post = (body: unknown) => admin("POST", "/api/admin/prizes", body);
      expect((await post({ name: "A", quantity: 2, positions: [1, 2, 3] })).status).toBe(400);
      expect((await post({ name: "A", quantity: 3, positions: [1, 1] })).status).toBe(400);
      expect((await post({ name: "A", quantity: 0, positions: [] })).status).toBe(400);
      expect((await post({ name: "A", quantity: 1, positions: [0] })).status).toBe(400);
      expect((await post({ name: "", quantity: 1, positions: [] })).status).toBe(400);
      expect((await post({ name: "A", quantity: 1, positions: [], imageId: "NOTUPLOADED" })).status).toBe(400);

      const imageId = await uploadImage(admin);
      expect((await post({ name: "A", quantity: 1, positions: [1], imageId })).status).toBe(201);
      expect((await post({ name: "B", quantity: 1, positions: [1], imageId })).status).toBe(400);
    });

    it("参加者には見せる設定のときだけ返し、管理者用の API は使えない", async () => {
      const admin = await adminClient();
      await admin("POST", "/api/admin/prizes", { name: "TV", quantity: 1, positions: [1] });
      const user = await participant();

      expect((await user("GET", "/api/prizes")).status).toBe(404);
      expect((await user("GET", "/api/admin/prizes")).status).toBe(401);
      expect((await createClient(app)("GET", "/api/prizes")).status).toBe(401);

      await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, prizesVisible: true });
      expect((await user("GET", "/api/me")).body.rules.prizesVisible).toBe(true);
      const res = await user("GET", "/api/prizes");
      expect(res.status).toBe(200);
      expect(res.body.prizes.map((p: any) => [p.name, p.positions])).toEqual([["TV", [1]]]);
    });
  });

  describe("スケジュール", () => {
    async function adminClient() {
      const request = createClient(app);
      await request("POST", "/api/admin/login", { password: ADMIN_PASSWORD });
      return request;
    }

    it("作成・更新・削除ができ、一覧は開始時刻の早い順", async () => {
      const admin = await adminClient();
      const toast = await admin("POST", "/api/admin/schedule", {
        title: " 乾杯 ",
        detail: "  幹事から一言\n  ",
        startMinute: 18 * 60 + 15,
        durationMinutes: 10,
      });
      expect(toast.status).toBe(201);
      expect(toast.body.item).toMatchObject({
        title: "乾杯",
        detail: "幹事から一言",
        startMinute: 1095,
        durationMinutes: 10,
      });
      await admin("POST", "/api/admin/schedule", {
        title: "開場",
        detail: "",
        startMinute: 18 * 60,
        durationMinutes: 15,
      });

      const list = await admin("GET", "/api/admin/schedule");
      expect(list.body.items.map((i: any) => i.title)).toEqual(["開場", "乾杯"]);
      expect(list.body.date).toBe("");

      // ドラッグで動かしたときと同じく、時刻と長さを変える
      const id = toast.body.item.itemId;
      const moved = await admin("PUT", `/api/admin/schedule/${id}`, {
        title: "乾杯",
        detail: "",
        startMinute: 17 * 60,
        durationMinutes: 20,
      });
      expect(moved.status).toBe(200);
      expect((await admin("GET", "/api/admin/schedule")).body.items.map((i: any) => i.title)).toEqual(["乾杯", "開場"]);

      expect((await admin("DELETE", `/api/admin/schedule/${id}`)).status).toBe(200);
      expect((await admin("DELETE", `/api/admin/schedule/${id}`)).status).toBe(404);
      expect(
        (
          await admin("PUT", `/api/admin/schedule/${id}`, {
            title: "x",
            detail: "",
            startMinute: 0,
            durationMinutes: 5,
          })
        ).status,
      ).toBe(404);
    });

    it("終わりが 24:00 を越える・5 分未満・長すぎる詳細は 400", async () => {
      const admin = await adminClient();
      const post = (body: Record<string, unknown>) =>
        admin("POST", "/api/admin/schedule", {
          title: "x",
          detail: "",
          startMinute: 600,
          durationMinutes: 30,
          ...body,
        });
      expect((await post({ startMinute: 23 * 60 + 45, durationMinutes: 30 })).status).toBe(400);
      expect((await post({ durationMinutes: 4 })).status).toBe(400);
      expect((await post({ startMinute: -5 })).status).toBe(400);
      expect((await post({ detail: "あ".repeat(501) })).status).toBe(400);
      expect((await post({ title: "" })).status).toBe(400);
    });

    it("参加者には見せる設定のときだけ、日付と一緒に返す", async () => {
      const admin = await adminClient();
      await admin("POST", "/api/admin/schedule", { title: "開場", detail: "", startMinute: 1080, durationMinutes: 15 });
      const token = await issueToken();
      const user = createClient(app);
      await user("POST", "/api/auth/register", { token, name: "参加者" });

      expect((await user("GET", "/api/schedule")).status).toBe(404);
      expect((await user("GET", "/api/admin/schedule")).status).toBe(401);

      expect(
        (await admin("PUT", "/api/admin/settings", { ...DEFAULT_SETTINGS, scheduleDate: "2026/12/20" })).status,
      ).toBe(400);
      await admin("PUT", "/api/admin/settings", {
        ...DEFAULT_SETTINGS,
        scheduleVisible: true,
        scheduleDate: "2026-12-20",
      });
      expect((await user("GET", "/api/me")).body.rules.scheduleVisible).toBe(true);
      const res = await user("GET", "/api/schedule");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ date: "2026-12-20", items: [{ title: "開場", startMinute: 1080 }] });
    });
  });

  describe("ゲーム", () => {
    let participantSeq = 0;
    async function participant(name: string) {
      const token = await issueToken();
      epithetSeq = [2, participantSeq++];
      const request = createClient(app);
      const reg = await request("POST", "/api/auth/register", { token, name });
      return { request, userId: reg.body.user.userId as string };
    }

    async function adminClient() {
      const request = createClient(app);
      await request("POST", "/api/admin/login", { password: ADMIN_PASSWORD });
      return request;
    }

    const me = async (request: ReturnType<typeof createClient>) => (await request("GET", "/api/me")).body.user;
    const pointsOf = async (admin: ReturnType<typeof createClient>) =>
      Object.fromEntries(
        (await admin("GET", "/api/admin/users")).body.users.map((u: any) => [u.name, [u.points, u.gamePoints]]),
      );

    it("作った・直したゲームは下書きのままではポイントに入らず、確定すると入り、取り消すと消える", async () => {
      const admin = await adminClient();
      const a = await participant("田中");
      const b = await participant("鈴木");
      const c = await participant("佐藤");
      const created = await admin("POST", "/api/admin/games", {
        format: "result",
        name: " じゃんけん大会 ",
        slots: [
          { name: "優勝", points: 30, userIds: [a.userId] },
          { name: "ベスト 4", points: 10, userIds: [] },
        ],
      });
      expect(created.status).toBe(201);
      const game = created.body.game;
      expect(game).toMatchObject({ name: "じゃんけん大会", status: "draft" });
      expect(game.confirmedAt).toBeUndefined();
      expect(game.slots.map((s: any) => [s.name, s.points, s.userIds])).toEqual([
        ["優勝", 30, [a.userId]],
        ["ベスト 4", 10, []],
      ]);
      expect(await pointsOf(admin)).toMatchObject({ 田中: [0, 0] });

      // 人を選び直す（枠の ID は残し、新しい枠を足す）
      const [win, best] = game.slots;
      const edited = await admin("PUT", `/api/admin/games/${game.gameId}`, {
        format: "result",
        name: "じゃんけん大会",
        slots: [
          { slotId: win.slotId, name: "優勝", points: 30, userIds: [a.userId] },
          { name: "準優勝", points: 20, userIds: [b.userId] },
          { slotId: best.slotId, name: "ベスト 4", points: 10, userIds: [c.userId] },
        ],
      });
      expect(edited.status).toBe(200);
      expect(edited.body.game.slots.map((s: any) => s.slotId)).toEqual([win.slotId, expect.any(String), best.slotId]);
      expect(await pointsOf(admin)).toMatchObject({ 田中: [0, 0], 鈴木: [0, 0], 佐藤: [0, 0] });

      const confirmed = await admin("POST", `/api/admin/games/${game.gameId}/confirm`);
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.game.status).toBe("confirmed");
      const confirmedAt = confirmed.body.game.confirmedAt;
      expect(confirmedAt).toEqual(expect.any(String));
      expect(await pointsOf(admin)).toMatchObject({ 田中: [30, 30], 鈴木: [20, 20], 佐藤: [10, 10] });
      expect((await admin("POST", `/api/admin/games/${game.gameId}/confirm`)).status).toBe(409);

      // 参加者のホーム: 点数と入った枠
      expect(await me(a.request)).toMatchObject({
        points: 30,
        gamePoints: 30,
        gameAwards: [{ gameName: "じゃんけん大会", slotName: "優勝", points: 30 }],
      });

      // ランキングと推移: 確定した時刻に入る
      const ranking = (await admin("GET", "/api/admin/ranking")).body.ranking;
      expect(ranking.map((e: any) => [e.name, e.points])).toEqual([
        ["田中", 30],
        ["鈴木", 20],
        ["佐藤", 10],
      ]);
      expect(ranking[0].history).toContainEqual({ at: confirmedAt, points: 30 });

      // 確定後に直すと数え直す（確定した時刻は変わらない）
      const fixed = await admin("PUT", `/api/admin/games/${game.gameId}`, {
        format: "result",
        name: "じゃんけん大会",
        slots: [
          { slotId: win.slotId, name: "優勝", points: 50, userIds: [b.userId] },
          { slotId: best.slotId, name: "ベスト 4", points: 10, userIds: [a.userId, c.userId] },
        ],
      });
      expect(fixed.body.game).toMatchObject({ status: "confirmed", confirmedAt });
      expect(await pointsOf(admin)).toMatchObject({ 田中: [10, 10], 鈴木: [50, 50], 佐藤: [10, 10] });

      const draft = await admin("POST", `/api/admin/games/${game.gameId}/unconfirm`);
      expect(draft.body.game.status).toBe("draft");
      expect(draft.body.game.confirmedAt).toBeUndefined();
      expect(await pointsOf(admin)).toMatchObject({ 田中: [0, 0], 鈴木: [0, 0], 佐藤: [0, 0] });
      expect((await admin("POST", `/api/admin/games/${game.gameId}/unconfirm`)).status).toBe(409);

      await admin("POST", `/api/admin/games/${game.gameId}/confirm`);
      expect((await admin("DELETE", `/api/admin/games/${game.gameId}`)).status).toBe(200);
      expect((await admin("GET", "/api/admin/games")).body.games).toEqual([]);
      expect(await pointsOf(admin)).toMatchObject({ 鈴木: [0, 0] });
      expect((await admin("DELETE", `/api/admin/games/${game.gameId}`)).status).toBe(404);
      expect((await admin("POST", `/api/admin/games/${game.gameId}/confirm`)).status).toBe(404);
    });

    it("入力を確かめる（点数の範囲・同じ人が 2 つの枠・知らない人や枠）", async () => {
      const admin = await adminClient();
      const a = await participant("田中");
      const post = (slots: unknown[]) => admin("POST", "/api/admin/games", { format: "result", name: "大会", slots });
      expect((await post([{ name: "優勝", points: 101, userIds: [] }])).status).toBe(400);
      expect((await post([{ name: "優勝", points: -1, userIds: [] }])).status).toBe(400);
      expect(
        (
          await post([
            { name: "優勝", points: 30, userIds: [a.userId] },
            { name: "準優勝", points: 20, userIds: [a.userId] },
          ])
        ).status,
      ).toBe(400);
      expect((await post([{ name: "優勝", points: 30, userIds: ["UNKNOWN"] }])).status).toBe(400);
      expect((await post([{ slotId: "S1", name: "優勝", points: 30, userIds: [] }])).status).toBe(400);
      expect((await admin("GET", "/api/admin/games")).body.games).toEqual([]);
      expect(
        (
          await admin("PUT", "/api/admin/games/NONE", {
            format: "result",
            name: "大会",
            slots: [{ name: "優勝", points: 1, userIds: [] }],
          })
        ).status,
      ).toBe(404);
    });

    it("画面が持っている版（updatedAt）がほかで変わっていたら、上書きせず 409 にする", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-01-01T01:00:00.000Z"));
        const admin = await adminClient();
        const a = await participant("田中");
        const b = await participant("鈴木");
        const { game } = (
          await admin("POST", "/api/admin/games", {
            format: "result",
            name: "大会",
            slots: [
              { name: "優勝", points: 30, userIds: [] },
              { name: "準優勝", points: 20, userIds: [] },
            ],
          })
        ).body;
        expect(game.updatedAt).toBe("2026-01-01T01:00:00.000Z");
        const [win, second] = game.slots;
        const body = (winners: string[], seconds: string[], baseUpdatedAt?: string) => ({
          format: "result",
          name: "大会",
          slots: [
            { slotId: win.slotId, name: "優勝", points: 30, userIds: winners },
            { slotId: second.slotId, name: "準優勝", points: 20, userIds: seconds },
          ],
          baseUpdatedAt,
        });
        // 1 つ目の枠を保存（版が進む）
        vi.setSystemTime(new Date("2026-01-01T01:01:00.000Z"));
        const first = await admin("PUT", `/api/admin/games/${game.gameId}`, body([a.userId], [], game.updatedAt));
        expect(first.status).toBe(200);
        expect(first.body.game.updatedAt).toBe("2026-01-01T01:01:00.000Z");
        // 古い版のまま 2 つ目の枠を保存すると 409 で、1 つ目の枠は消えない
        vi.setSystemTime(new Date("2026-01-01T01:02:00.000Z"));
        const stale = await admin("PUT", `/api/admin/games/${game.gameId}`, body([], [b.userId], game.updatedAt));
        expect(stale.status).toBe(409);
        const list = (await admin("GET", "/api/admin/games")).body.games;
        expect(list[0].slots.map((s: any) => s.userIds)).toEqual([[a.userId], []]);
        // 今の版なら保存できる。確定・取り消しでも版は進む
        const ok = await admin(
          "PUT",
          `/api/admin/games/${game.gameId}`,
          body([a.userId], [b.userId], first.body.game.updatedAt),
        );
        expect(ok.status).toBe(200);
        vi.setSystemTime(new Date("2026-01-01T01:03:00.000Z"));
        const confirmed = await admin("POST", `/api/admin/games/${game.gameId}/confirm`);
        expect(confirmed.body.game.updatedAt).toBe("2026-01-01T01:03:00.000Z");
        expect(
          (await admin("PUT", `/api/admin/games/${game.gameId}`, body([a.userId], [], ok.body.game.updatedAt))).status,
        ).toBe(409);
      } finally {
        vi.useRealTimers();
      }
    });

    it("名前だけで作れ、枠は後から足せる。枠が無いゲームは確定できない", async () => {
      const admin = await adminClient();
      const a = await participant("田中");
      const created = await admin("POST", "/api/admin/games", { format: "result", name: "ビンゴ", slots: [] });
      expect(created.status).toBe(201);
      const { game } = created.body;
      expect(game.slots).toEqual([]);
      expect((await admin("POST", `/api/admin/games/${game.gameId}/confirm`)).status).toBe(409);
      expect((await admin("GET", "/api/admin/games")).body.games[0].status).toBe("draft");

      const added = await admin("PUT", `/api/admin/games/${game.gameId}`, {
        format: "result",
        name: "ビンゴ",
        slots: [{ name: "1 番乗り", points: 10, userIds: [a.userId] }],
        baseUpdatedAt: game.updatedAt,
      });
      expect(added.status).toBe(200);
      expect((await admin("POST", `/api/admin/games/${game.gameId}/confirm`)).status).toBe(200);
      expect(await pointsOf(admin)).toMatchObject({ 田中: [10, 10] });
      // 確定後に枠を全部外すこともでき、そのときはポイントも入らない
      const emptied = await admin("PUT", `/api/admin/games/${game.gameId}`, {
        format: "result",
        name: "ビンゴ",
        slots: [],
      });
      expect(emptied.status).toBe(200);
      expect(await pointsOf(admin)).toMatchObject({ 田中: [0, 0] });
      expect((await admin("POST", "/api/admin/games/NONE/confirm")).status).toBe(404);
    });

    it("紐づけを解除した人は新しく選べないが、選んだ後に解除された人はそのまま残せる", async () => {
      const admin = await adminClient();
      const a = await participant("田中");
      const b = await participant("鈴木");
      const { game } = (
        await admin("POST", "/api/admin/games", {
          format: "result",
          name: "大会",
          slots: [{ name: "優勝", points: 10, userIds: [a.userId] }],
        })
      ).body;
      await admin("POST", `/api/admin/users/${a.userId}/unbind`);
      await admin("POST", `/api/admin/users/${b.userId}/unbind`);
      const slotId = game.slots[0].slotId;
      const put = (userIds: string[]) =>
        admin("PUT", `/api/admin/games/${game.gameId}`, {
          format: "result",
          name: "大会",
          slots: [{ slotId, name: "優勝", points: 10, userIds }],
        });
      expect((await put([a.userId])).status).toBe(200);
      expect((await put([a.userId, b.userId])).status).toBe(400);
      expect(
        (
          await admin("POST", "/api/admin/games", {
            format: "result",
            name: "別",
            slots: [{ name: "優勝", points: 10, userIds: [a.userId] }],
          })
        ).status,
      ).toBe(400);
    });

    it("ゲームの点数を伏せると、参加者には点数と入った枠を返さない（合計には入る）", async () => {
      const admin = await adminClient();
      const a = await participant("田中");
      const { game } = (
        await admin("POST", "/api/admin/games", {
          format: "result",
          name: "大会",
          slots: [{ name: "勝ち残り", points: 10, userIds: [a.userId] }],
        })
      ).body;
      await admin("POST", `/api/admin/games/${game.gameId}/confirm`);
      const settings = (await admin("GET", "/api/admin/settings")).body.settings;
      await admin("PUT", "/api/admin/settings", { ...settings, showGamePoints: false });
      const user = await me(a.request);
      expect(user.points).toBe(10);
      expect(user.gamePoints).toBeUndefined();
      expect(user.gameAwards).toBeUndefined();
      expect((await a.request("GET", "/api/me")).body.rules.showGamePoints).toBe(false);
    });

    it("管理画面以外からは操作できない", async () => {
      const a = await participant("田中");
      expect((await a.request("GET", "/api/admin/games")).status).toBe(401);
      expect((await a.request("POST", "/api/admin/games", { name: "x", slots: [] })).status).toBe(401);
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
  /** クイズ形式のゲーム（確定は 2:00） */
  const quiz = (gameId = "Q1", status: "open" | "confirmed" = "confirmed") => ({
    gameId,
    format: "quiz" as const,
    name: "問題",
    description: "",
    status,
    slots: [],
    ranks: [],
    voterPoints: 0,
    choices: [
      { choiceId: "A", text: "a", points: 10 },
      { choiceId: "B", text: "b", points: 0 },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(status === "confirmed" ? { confirmedAt: "2026-01-01T02:00:00.000Z" } : {}),
  });
  const answer = (gameId: string, userId: string, choiceId: string, answeredAt: string) => ({
    gameId,
    userId,
    choiceId,
    answeredAt,
  });
  const photo = (photoId: string, uploaderId: string, createdAt: string, reviewedAt?: string) => ({
    photoId,
    uploaderId,
    status: "approved" as const,
    favoriteCount: 0,
    createdAt,
    reviewedAt,
  });

  it("写真は公開した時刻、お気に入りは選ばれた時刻（選んだ人も同じ時刻）、ゲームは確定した時刻に加え、同じ時刻はまとめる", () => {
    const result = buildRanking({
      users: [
        user("u1", "田中", { approvedCount: 2, favoritesReceived: 1 }),
        user("u2", "鈴木", { approvedCount: 0, favoritesGiven: 1 }),
        user("u3", "佐藤", { approvedCount: 1 }),
      ],
      settings: { ...DEFAULT_SETTINGS, uploadPoints: 2, favoritePoints: 3, favoriteGivenPoints: 5 },
      games: [
        {
          game: quiz(),
          answers: [
            answer("Q1", "u2", "A", "2026-01-01T01:59:00.000Z"),
            answer("Q1", "u3", "B", "2026-01-01T01:59:00.000Z"),
            // 確定の後に保存された答え（確定の直前に受け付けたもの）は数えない
            answer("Q1", "u1", "A", "2026-01-01T02:00:00.001Z"),
          ],
        },
        // 開催中のゲームは数えない
        { game: quiz("Q2", "open"), answers: [answer("Q2", "u1", "A", "2026-01-01T01:30:00.000Z")] },
      ],
      photos: [
        // 事前確認は承認した時刻
        photo("P1", "u1", "2026-01-01T00:10:00.000Z", "2026-01-01T00:20:00.000Z"),
        // 事後確認は投稿した時刻
        photo("P2", "u1", "2026-01-01T00:20:00.000Z"),
        photo("P3", "u3", "2026-01-01T00:30:00.000Z"),
      ],
      favorites: [
        { userId: "u2", photoId: "P2", createdAt: "2026-01-01T01:00:00.000Z" },
        // 公開中でない写真へのお気に入り（削除の後片付けの途中など）は、選んだ人にも数えない
        { userId: "u3", photoId: "PX", createdAt: "2026-01-01T01:30:00.000Z" },
      ],
      now: "2026-01-01T03:00:00.000Z",
    });

    expect(result.generatedAt).toBe("2026-01-01T03:00:00.000Z");
    expect(result.ranking.map((r) => [r.rank, r.userId, r.points])).toEqual([
      [1, "u2", 15],
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
      { at: "2026-01-01T01:00:00.000Z", points: 5 },
      { at: "2026-01-01T02:00:00.000Z", points: 15 },
      { at: "2026-01-01T03:00:00.000Z", points: 15 },
    ]);
    // 0 点の選択肢は点を増やさない
    expect(result.ranking[2]!.history.map((h) => h.points)).toEqual([0, 2, 2]);
  });

  it("合計も項目のポイントも同じ人は、登録順（先に登録した人が上）で別の順位にする", () => {
    const result = buildRanking({
      users: [user("u3", "佐藤"), user("u1", "田中", { approvedCount: 1 }), user("u2", "鈴木", { approvedCount: 1 })],
      settings: DEFAULT_SETTINGS,
      photos: [],
      favorites: [],
      now: "2026-01-01T03:00:00.000Z",
    });
    expect(result.ranking.map((r) => [r.rank, r.userId])).toEqual([
      [1, "u1"],
      [2, "u2"],
      [3, "u3"],
    ]);
    // 推移の元データが無くても、最後の点はユーザのカウンタから計算したポイント
    expect(result.ranking[0]!.history.at(-1)).toEqual({ at: "2026-01-01T03:00:00.000Z", points: 1 });
  });

  it("確定したゲームの点数は合計に入り、同じポイントのときの項目としても比べる（下書きは数えない）", () => {
    const game = (status: "draft" | "confirmed", userIds: string[]) => ({
      gameId: `G-${status}`,
      format: "result" as const,
      name: "大会",
      description: "",
      status,
      slots: [{ slotId: "S1", name: "優勝", points: 10, userIds }],
      choices: [],
      ranks: [],
      voterPoints: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...(status === "confirmed" ? { confirmedAt: "2026-01-01T02:00:00.000Z" } : {}),
    });
    const rank = (order: typeof DEFAULT_SETTINGS.tieBreakOrder) =>
      buildRanking({
        // u1 は写真で 10 点、u2 はゲームで 10 点（u3 は下書きのゲームだけなので 0 点）
        users: [user("u1", "田中", { approvedCount: 10 }), user("u2", "鈴木"), user("u3", "佐藤")],
        settings: { ...DEFAULT_SETTINGS, uploadPoints: 1, tieBreakOrder: order },
        photos: [],
        favorites: [],
        games: [game("confirmed", ["u2"]), game("draft", ["u3"])].map((g) => ({ game: g, answers: [] })),
        now: "2026-01-01T03:00:00.000Z",
      }).ranking;
    const byDefault = rank(DEFAULT_SETTINGS.tieBreakOrder);
    expect(byDefault.map((r) => [r.rank, r.userId, r.points])).toEqual([
      [1, "u1", 10],
      [2, "u2", 10],
      [3, "u3", 0],
    ]);
    expect(byDefault[1]!.history).toEqual([
      { at: "2026-01-01T00:00:02.000Z", points: 0 },
      { at: "2026-01-01T02:00:00.000Z", points: 10 },
      { at: "2026-01-01T03:00:00.000Z", points: 10 },
    ]);
    expect(rank(["game", "upload", "favoriteGiven", "favoriteReceived", "registered"]).map((r) => r.userId)).toEqual([
      "u2",
      "u1",
      "u3",
    ]);
  });

  it("登録の時刻まで同じ人も、ユーザ ID の順で別の順位にする", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const result = buildRanking({
      users: [user("u2", "鈴木", { createdAt: at }), user("u1", "田中", { createdAt: at })],
      settings: DEFAULT_SETTINGS,
      photos: [],
      favorites: [],
      now: "2026-01-01T03:00:00.000Z",
    });
    expect(result.ranking.map((r) => [r.rank, r.userId])).toEqual([
      [1, "u1"],
      [2, "u2"],
    ]);
  });

  // 合計はどちらも 10 点。u1 は写真で 10 点、u2 はお気に入りを選んで 10 点、u3 はゲーム（クイズ形式）で 10 点
  const tied = () => [
    user("u1", "田中", { approvedCount: 10 }),
    user("u2", "鈴木", { favoritesGiven: 1 }),
    user("u3", "佐藤"),
  ];
  const quizFor = (userId: string) => [
    { game: quiz(), answers: [answer("Q1", userId, "A", "2026-01-01T01:00:00.000Z")] },
  ];
  const rankOf = (settings: typeof DEFAULT_SETTINGS) =>
    buildRanking({
      users: tied(),
      settings: { ...settings, uploadPoints: 1, favoriteGivenPoints: 10 },
      games: quizFor("u3"),
      photos: [],
      favorites: [],
      now: "2026-01-01T03:00:00.000Z",
    }).ranking.map((r) => [r.rank, r.userId, r.points]);

  it("同じポイントは、既定では写真のアップロード → お気に入りを選んだ → 選ばれた → ゲームの順に比べ、順位も分ける", () => {
    expect(rankOf(DEFAULT_SETTINGS)).toEqual([
      [1, "u1", 10],
      [2, "u2", 10],
      [3, "u3", 10],
    ]);
  });

  it("優先順を並べ替えると、その順に比べる", () => {
    expect(
      rankOf({
        ...DEFAULT_SETTINGS,
        tieBreakOrder: ["game", "favoriteGiven", "upload", "favoriteReceived", "registered"],
      }),
    ).toEqual([
      [1, "u3", 10],
      [2, "u2", 10],
      [3, "u1", 10],
    ]);
  });

  it("登録順を先頭にすると、ポイントの項目より先に登録順で比べる", () => {
    // 合計はどちらも 10 点。先に登録した u1 はゲームで、u2 は写真で 10 点
    const rank = (tieBreakOrder: typeof DEFAULT_SETTINGS.tieBreakOrder) =>
      buildRanking({
        users: [user("u2", "鈴木", { approvedCount: 10 }), user("u1", "田中")],
        settings: { ...DEFAULT_SETTINGS, uploadPoints: 1, tieBreakOrder },
        games: quizFor("u1"),
        photos: [],
        favorites: [],
        now: "2026-01-01T03:00:00.000Z",
      }).ranking.map((r) => [r.rank, r.userId]);
    expect(rank(DEFAULT_SETTINGS.tieBreakOrder)).toEqual([
      [1, "u2"],
      [2, "u1"],
    ]);
    expect(rank(["registered", "upload", "favoriteGiven", "favoriteReceived", "game"])).toEqual([
      [1, "u1"],
      [2, "u2"],
    ]);
  });

  it("参加者向けに紐づけを解除した人を除くと、並び順のとおりに 1 位から付け直す", () => {
    const ranking = buildRanking({
      users: [
        user("u1", "田中", { approvedCount: 10 }),
        user("u2", "鈴木", { approvedCount: 10, status: "unbound" }),
        user("u3", "佐藤", { approvedCount: 10 }),
        user("u4", "高橋", { favoritesGiven: 1 }),
      ],
      settings: { ...DEFAULT_SETTINGS, uploadPoints: 1, favoriteGivenPoints: 10 },
      photos: [],
      favorites: [],
      now: "2026-01-01T03:00:00.000Z",
    });
    expect(ranking.ranking.map((r) => [r.rank, r.userId])).toEqual([
      [1, "u1"],
      [2, "u2"],
      [3, "u3"],
      [4, "u4"],
    ]);
    expect(toParticipantRanking(ranking, false, false).ranking.map((r) => [r.rank, r.userId])).toEqual([
      [1, "u1"],
      [2, "u3"],
      [3, "u4"],
    ]);
  });
});
