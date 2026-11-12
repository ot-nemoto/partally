import { describe, expect, it } from "vitest";
import { ADMIN_PASSWORD, createClient, useApiTest } from "./test-support.js";

describe("API", () => {
  const t = useApiTest();

  describe("管理者", () => {
    async function adminClient() {
      const request = createClient(t.app);
      const login = await request("POST", "/api/admin/login", { password: ADMIN_PASSWORD });
      expect(login.status).toBe(200);
      expect(login.headers.getSetCookie()[0]).toMatch(/Path=\/api\/admin/);
      return request;
    }

    it("パスワードが違えばログインできず、管理 API は 401", async () => {
      const request = createClient(t.app);
      expect((await request("POST", "/api/admin/login", { password: "wrong" })).status).toBe(401);
      expect((await request("GET", "/api/admin/users")).status).toBe(401);
      expect((await request("GET", "/api/admin/me")).status).toBe(401);
    });

    it("参加者のセッションでは管理 API を使えない", async () => {
      const token = await t.issueToken();
      const request = createClient(t.app);
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
      await createClient(t.app)("POST", "/api/auth/register", { token, name: "田中" });

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
      const t1 = await t.issueToken();
      const t2 = await t.issueToken();
      t.epithets = [0, 0];
      const a = await createClient(t.app)("POST", "/api/auth/register", { token: t1, name: "田中" });
      t.epithets = [0, 1];
      const b = await createClient(t.app)("POST", "/api/auth/register", { token: t2, name: "鈴木" });
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
      const token = await t.issueToken();
      const participant = createClient(t.app);
      const reg = await participant("POST", "/api/auth/register", { token, name: "田中" });
      const admin = await adminClient();

      const unbind = await admin("POST", `/api/admin/users/${reg.body.user.userId}/unbind`);
      expect(unbind.status).toBe(200);
      expect(unbind.body.user.status).toBe("unbound");
      expect((await admin("POST", `/api/admin/users/${reg.body.user.userId}/unbind`)).status).toBe(404);

      expect((await participant("GET", "/api/me")).status).toBe(401);
      expect((await participant("POST", "/api/auth/qr", { token })).body).toEqual({ status: "unbound" });

      // 解除済みユーザの二つ名は確保されたままなので、別の二つ名になる
      t.epithets = [0, 0, 0, 1];
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
