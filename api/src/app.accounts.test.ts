import { DEVICE_ACCOUNTS_MAX } from "@partally/shared";
import { describe, expect, it } from "vitest";
import { ingestUpload } from "./ingest.js";
import { photoKey } from "./photo-storage.js";
import { jpegBytes, useApiTest } from "./test-support.js";

/** Cookie を覚える 1 台の端末。Cookie を書き換えたり消したりして試せるよう、中身を外から触れるようにする */
function device(app: ReturnType<typeof useApiTest>["app"]) {
  const jar = new Map<string, string>();
  const request = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (method !== "GET") headers["content-type"] = "application/json";
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
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };
  return { request, jar };
}

describe("1 台の端末で複数の参加者を切り替える", () => {
  const t = useApiTest();

  /** この端末で QR から登録する（二つ名が重ならないよう、人ごとに乱数を変える） */
  async function registerOn(d: ReturnType<typeof device>, name: string, n: number) {
    const token = await t.issueToken();
    t.randomInts = [0, n];
    const res = await d.request("POST", "/api/auth/register", { token, name, pin: "1234" });
    expect(res.status).toBe(201);
    return { token, userId: res.body.user.userId as string };
  }

  it("ログインした参加者を新しい順に覚え、暗証番号なしで切り替えられる", async () => {
    const d = device(t.app);
    const parent = await registerOn(d, "親", 1);
    const child = await registerOn(d, "子", 2);

    const list = await d.request("GET", "/api/accounts");
    expect(list.body.current).toBe(child.userId);
    expect(list.body.accounts.map((a: { name: string }) => a.name)).toEqual(["子", "親"]);

    const switched = await d.request("POST", "/api/accounts/switch", { userId: parent.userId });
    expect(switched.status).toBe(200);
    expect(switched.body.user.name).toBe("親");
    expect((await d.request("GET", "/api/me")).body.user.name).toBe("親");
    expect((await d.request("GET", "/api/accounts")).body.accounts.map((a: { name: string }) => a.name)).toEqual([
      "親",
      "子",
    ]);
  });

  it("覚えている参加者の QR を読み込んだときは、暗証番号を聞かずにログインする", async () => {
    const d = device(t.app);
    const parent = await registerOn(d, "親", 1);
    const child = await registerOn(d, "子", 2);
    await d.request("POST", "/api/accounts/switch", { userId: parent.userId });
    const res = await d.request("POST", "/api/auth/qr", { token: child.token });
    expect(res.body).toMatchObject({ status: "bound", user: { name: "子" } });
  });

  it("覚えていない参加者には切り替えられず、その人の QR では暗証番号を聞く", async () => {
    const d = device(t.app);
    await registerOn(d, "親", 1);
    const other = device(t.app);
    const stranger = await registerOn(other, "他人", 3);
    expect((await d.request("POST", "/api/accounts/switch", { userId: stranger.userId })).status).toBe(404);
    expect((await d.request("POST", "/api/auth/qr", { token: stranger.token })).body).toEqual({
      status: "pin_required",
      setup: false,
    });
  });

  it("紐づけを解除された参加者は一覧から外れ、切り替えられない", async () => {
    const d = device(t.app);
    const parent = await registerOn(d, "親", 1);
    const child = await registerOn(d, "子", 2);
    const admin = await t.adminClient();
    await admin("POST", `/api/admin/users/${child.userId}/unbind`);
    const list = await d.request("GET", "/api/accounts");
    expect(list.body.accounts.map((a: { userId: string }) => a.userId)).toEqual([parent.userId]);
    expect(list.body.current).toBeUndefined();
    expect((await d.request("POST", "/api/accounts/switch", { userId: child.userId })).status).toBe(404);
    expect((await d.request("POST", "/api/accounts/switch", { userId: parent.userId })).status).toBe(200);
  });

  it(`覚えるのは ${DEVICE_ACCOUNTS_MAX} 人までで、超えたら古い人から外す`, async () => {
    const d = device(t.app);
    const users = [];
    for (let i = 0; i <= DEVICE_ACCOUNTS_MAX; i++) users.push(await registerOn(d, `人${i}`, i + 1));
    const ids = (await d.request("GET", "/api/accounts")).body.accounts.map((a: { userId: string }) => a.userId);
    expect(ids).toHaveLength(DEVICE_ACCOUNTS_MAX);
    expect(ids).not.toContain(users[0]!.userId);
    expect(ids[0]).toBe(users[DEVICE_ACCOUNTS_MAX]!.userId);
  });

  it("ログアウトは今の参加者だけを外し、ほかに覚えている人がいればその人に切り替える", async () => {
    const d = device(t.app);
    const parent = await registerOn(d, "親", 1);
    await registerOn(d, "子", 2);
    const first = await d.request("POST", "/api/auth/logout");
    expect(first.body.user.name).toBe("親");
    expect(await d.request("GET", "/api/accounts")).toMatchObject({
      body: { current: parent.userId, accounts: [{ name: "親" }] },
    });
    const second = await d.request("POST", "/api/auth/logout");
    expect(second.body).toEqual({});
    expect((await d.request("GET", "/api/me")).status).toBe(401);
    expect((await d.request("GET", "/api/accounts")).body).toEqual({ accounts: [] });
  });

  it("一覧の Cookie を書き換えると使えない（署名が合わない）", async () => {
    const d = device(t.app);
    await registerOn(d, "親", 1);
    const other = device(t.app);
    const stranger = await registerOn(other, "他人", 3);
    const [body, sig] = d.jar.get("accounts")!.split(".");
    const forged = Buffer.from(
      JSON.stringify({ acc: [{ uid: stranger.userId, tok: stranger.token }], iat: Math.floor(Date.now() / 1000) }),
    ).toString("base64url");
    expect(forged).not.toBe(body);
    d.jar.set("accounts", `${forged}.${sig}`);
    expect((await d.request("POST", "/api/accounts/switch", { userId: stranger.userId })).status).toBe(404);
  });

  it("一覧を使う前からログインしていた人も、次に別の人がログインしたときに一覧に入る", async () => {
    const d = device(t.app);
    const parent = await registerOn(d, "親", 1);
    d.jar.delete("accounts");
    await registerOn(d, "子", 2);
    const ids = (await d.request("GET", "/api/accounts")).body.accounts.map((a: { userId: string }) => a.userId);
    expect(ids).toContain(parent.userId);
  });

  it("送信待ちの写真は、この端末で覚えている参加者を指定すれば、その人の写真として送れる", async () => {
    const d = device(t.app);
    const parent = await registerOn(d, "親", 1);
    await registerOn(d, "子", 2);
    const res = await d.request("POST", "/api/photos/upload-url", { userId: parent.userId });
    expect(res.status).toBe(200);
    for (const kind of ["thumb", "full"] as const) {
      const { fields } = res.body[kind];
      t.storage.put(fields.key, jpegBytes(), fields["x-amz-meta-uploader"]);
    }
    await ingestUpload(t, photoKey("uploads", res.body.photoId, "full"));
    expect((await t.repo.getPhoto(res.body.photoId))?.uploaderId).toBe(parent.userId);

    const stranger = await registerOn(device(t.app), "他人", 3);
    expect((await d.request("POST", "/api/photos/upload-url", { userId: stranger.userId })).status).toBe(403);
  });

  it("今の参加者が紐づけ解除されたら、自分の情報を読み直したときに、覚えているほかの参加者に切り替わる", async () => {
    const d = device(t.app);
    const parent = await registerOn(d, "親", 1);
    const child = await registerOn(d, "子", 2);
    const admin = await t.adminClient();
    await admin("POST", `/api/admin/users/${child.userId}/unbind`);

    // ほかの操作は、別の参加者として行わない（401 のまま）
    expect((await d.request("POST", "/api/photos/upload-url")).status).toBe(401);

    const me = await d.request("GET", "/api/me");
    expect(me.status).toBe(200);
    expect(me.body.user.userId).toBe(parent.userId);
    expect((await d.request("GET", "/api/accounts")).body).toEqual({
      current: parent.userId,
      accounts: [expect.objectContaining({ userId: parent.userId })],
    });
    expect((await d.request("POST", "/api/photos/upload-url")).status).toBe(200);
  });

  it("覚えている参加者が誰も使えなければ、ログインしていない状態になる", async () => {
    const d = device(t.app);
    const only = await registerOn(d, "ひとり", 1);
    const admin = await t.adminClient();
    await admin("POST", `/api/admin/users/${only.userId}/unbind`);
    expect((await d.request("GET", "/api/me")).status).toBe(401);
    expect(d.jar.has("session")).toBe(false);
    expect(d.jar.has("accounts")).toBe(false);
  });
});
