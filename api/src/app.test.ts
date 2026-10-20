import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { MemoryRepository } from "./memory-repository.js";

const ADMIN_PASSWORD = "secret-password";

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
  let app: ReturnType<typeof createApp>;
  let epithetSeq: number[];

  beforeEach(() => {
    repo = new MemoryRepository();
    epithetSeq = [];
    let id = 0;
    app = createApp({
      repo,
      sessionSecret: "test-secret",
      adminPassword: ADMIN_PASSWORD,
      secureCookies: true,
      // 二つ名の抽選結果をテストから指定できるようにする（未指定なら 0）
      randomInt: () => epithetSeq.shift() ?? 0,
      newId: () => `user-${++id}`,
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
});
