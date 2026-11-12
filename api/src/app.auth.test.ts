import { describe, expect, it } from "vitest";
import { createClient, useApiTest } from "./test-support.js";

describe("API", () => {
  const t = useApiTest();

  describe("QR ログイン・初回登録", () => {
    it("未紐づけトークンは unbound を返し、名前登録で二つ名が付く", async () => {
      const token = await t.issueToken();
      const request = createClient(t.app);

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
      const token = await t.issueToken();
      await createClient(t.app)("POST", "/api/auth/register", { token, name: "田中" });

      const other = createClient(t.app);
      expect((await other("GET", "/api/me")).status).toBe(401);
      const qr = await other("POST", "/api/auth/qr", { token });
      expect(qr.body).toMatchObject({ status: "bound", user: { name: "田中" } });
      expect((await other("GET", "/api/me")).status).toBe(200);
    });

    it("同名でも二つ名が重複しないよう再抽選する", async () => {
      const t1 = await t.issueToken();
      const t2 = await t.issueToken();
      const request = createClient(t.app);

      // 1 人目: (0,0)。2 人目: 最初に (0,0) が出て衝突 → (0,1) で確定
      t.epithets = [0, 0];
      const a = await request("POST", "/api/auth/register", { token: t1, name: "田中" });
      t.epithets = [0, 0, 0, 1];
      const b = await request("POST", "/api/auth/register", { token: t2, name: "田中" });

      expect(a.body.user.epithet).toBe("疾風の魔術師");
      expect(b.body.user.epithet).toBe("疾風の剣士");
    });

    it("存在しないトークンは 404、紐づけ済みトークンへの登録は 409", async () => {
      const request = createClient(t.app);
      const unknown = "b".repeat(22);
      expect((await request("POST", "/api/auth/qr", { token: unknown })).body.error).toBe("invalid_token");

      const token = await t.issueToken();
      await request("POST", "/api/auth/register", { token, name: "田中" });
      const again = await request("POST", "/api/auth/register", { token, name: "鈴木" });
      expect(again.status).toBe(409);
      expect(again.body.error).toBe("token_already_bound");
    });

    it("形式不正な入力は 400、JSON 以外は 415", async () => {
      const request = createClient(t.app);
      expect((await request("POST", "/api/auth/qr", { token: "short" })).status).toBe(400);
      const token = await t.issueToken();
      expect((await request("POST", "/api/auth/register", { token, name: "　" })).status).toBe(400);

      const res = await t.app.request("/api/auth/qr", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ token }),
      });
      expect(res.status).toBe(415);
    });

    it("改ざんされたセッション Cookie は拒否する", async () => {
      const res = await t.app.request("/api/me", {
        headers: { cookie: "session=eyJ1aWQiOiJ1c2VyLTEiLCJ0b2siOiJ4IiwiaWF0IjoxfQ.forged" },
      });
      expect(res.status).toBe(401);
    });
  });
});
