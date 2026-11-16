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

      const reg = await request("POST", "/api/auth/register", { token, name: " 田中　太郎 ", pin: "1234" });
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

    it("ログインしたままの端末は QR だけでログインでき、ほかの端末は暗証番号が要る", async () => {
      const token = await t.issueToken();
      const first = createClient(t.app);
      await first("POST", "/api/auth/register", { token, name: "田中", pin: "1234" });
      // 登録した端末は、読み込み直しても番号を聞かない
      expect((await first("POST", "/api/auth/qr", { token })).body).toMatchObject({ status: "bound" });

      const other = createClient(t.app);
      expect((await other("GET", "/api/me")).status).toBe(401);
      expect((await other("POST", "/api/auth/qr", { token })).body).toEqual({ status: "pin_required", setup: false });
      expect((await other("GET", "/api/me")).status).toBe(401);
      const wrong = await other("POST", "/api/auth/qr", { token, pin: "9999" });
      expect(wrong.status).toBe(401);
      expect(wrong.body).toMatchObject({ error: "pin_invalid", message: "あと 4 回" });
      expect((await other("GET", "/api/me")).status).toBe(401);
      // 全角の数字でも入れられる
      const qr = await other("POST", "/api/auth/qr", { token, pin: "１２３４" });
      expect(qr.body).toMatchObject({ status: "bound", user: { name: "田中" } });
      expect((await other("GET", "/api/me")).status).toBe(200);
      // 合えば間違えた回数は戻る
      const [user] = await t.repo.listUsers();
      expect(user!.pinFailures).toBe(0);
      expect(user!.pinHash).toMatch(/^scrypt\$/);
      expect(user!.pinHash).not.toContain("1234");
    });

    it("暗証番号を 5 回続けて間違えるとロックし、合う番号でも入れない。同時に送っても 5 回までしか試せない", async () => {
      const token = await t.issueToken();
      await createClient(t.app)("POST", "/api/auth/register", { token, name: "田中", pin: "1234" });
      const other = createClient(t.app);
      const results = await Promise.all(
        ["0000", "0001", "0002", "0003", "0004", "0005", "0006", "1234"].map((pin) =>
          other("POST", "/api/auth/qr", { token, pin }),
        ),
      );
      expect(results.filter((r) => r.body.status === "bound").length).toBeLessThanOrEqual(1);
      const [user] = await t.repo.listUsers();
      expect(user!.pinFailures).toBeLessThanOrEqual(5);

      // 順に 5 回間違える
      const token2 = await t.issueToken();
      t.randomInts = [0, 1];
      await createClient(t.app)("POST", "/api/auth/register", { token: token2, name: "鈴木", pin: "1111" });
      const statuses = [];
      for (let i = 0; i < 5; i++)
        statuses.push((await other("POST", "/api/auth/qr", { token: token2, pin: "2222" })).status);
      expect(statuses).toEqual([401, 401, 401, 401, 423]);
      const locked = await other("POST", "/api/auth/qr", { token: token2, pin: "1111" });
      expect(locked.status).toBe(423);
      expect(locked.body.error).toBe("pin_locked");
      expect((await other("POST", "/api/auth/qr", { token: token2 })).status).toBe(423);
      expect((await other("GET", "/api/me")).status).toBe(401);
    });

    it("暗証番号の無い人は、ほかの端末で読み込んだときに決めてからログインする", async () => {
      const token = await t.issueToken();
      const first = createClient(t.app);
      const reg = await first("POST", "/api/auth/register", { token, name: "田中", pin: "1234" });
      await t.repo.clearUserPin(reg.body.user.userId);

      const other = createClient(t.app);
      expect((await other("POST", "/api/auth/qr", { token })).body).toEqual({ status: "pin_required", setup: true });
      expect((await other("POST", "/api/auth/qr", { token, pin: "5678" })).body).toMatchObject({ status: "bound" });
      // 決めた番号が要る
      const third = createClient(t.app);
      expect((await third("POST", "/api/auth/qr", { token })).body).toEqual({ status: "pin_required", setup: false });
      expect((await third("POST", "/api/auth/qr", { token, pin: "1234" })).status).toBe(401);
      expect((await third("POST", "/api/auth/qr", { token, pin: "5678" })).body).toMatchObject({ status: "bound" });
    });

    it("登録には 4 桁の数字の暗証番号が要る", async () => {
      const request = createClient(t.app);
      const token = await t.issueToken();
      for (const pin of [undefined, "", "123", "12345", "12a4"]) {
        expect((await request("POST", "/api/auth/register", { token, name: "田中", pin })).status).toBe(400);
      }
      expect((await request("POST", "/api/auth/qr", { token, pin: "12" })).status).toBe(400);
    });

    it("同名でも二つ名が重複しないよう再抽選する", async () => {
      const t1 = await t.issueToken();
      const t2 = await t.issueToken();
      const request = createClient(t.app);

      // 1 人目: (0,0)。2 人目: 最初に (0,0) が出て衝突 → (0,1) で確定
      t.randomInts = [0, 0];
      const a = await request("POST", "/api/auth/register", { token: t1, name: "田中", pin: "1234" });
      t.randomInts = [0, 0, 0, 1];
      const b = await request("POST", "/api/auth/register", { token: t2, name: "田中", pin: "1234" });

      expect(a.body.user.epithet).toBe("疾風の魔術師");
      expect(b.body.user.epithet).toBe("疾風の剣士");
    });

    it("存在しないトークンは 404、紐づけ済みトークンへの登録は 409", async () => {
      const request = createClient(t.app);
      const unknown = "b".repeat(22);
      expect((await request("POST", "/api/auth/qr", { token: unknown })).body.error).toBe("invalid_token");

      const token = await t.issueToken();
      await request("POST", "/api/auth/register", { token, name: "田中", pin: "1234" });
      const again = await request("POST", "/api/auth/register", { token, name: "鈴木", pin: "1234" });
      expect(again.status).toBe(409);
      expect(again.body.error).toBe("token_already_bound");
    });

    it("形式不正な入力は 400、JSON 以外は 415", async () => {
      const request = createClient(t.app);
      expect((await request("POST", "/api/auth/qr", { token: "short" })).status).toBe(400);
      const token = await t.issueToken();
      expect((await request("POST", "/api/auth/register", { token, name: "　", pin: "1234" })).status).toBe(400);

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
