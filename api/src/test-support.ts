import { beforeEach } from "vitest";
import { createApp } from "./app.js";
import { MemoryRepository } from "./memory-repository.js";
import { MemoryPhotoStorage } from "./memory-storage.js";
import type { UrlSigner } from "./url-signer.js";

/** テスト用の管理者パスワード */
export const ADMIN_PASSWORD = "secret-password";

/** 署名の代わりに印を付けるだけの署名器 */
export const testSigner: UrlSigner = {
  approvedCookies: () => ({ "CloudFront-Policy": "policy", "CloudFront-Signature": "sig" }),
  signPath: (path) => `${path}?signed`,
};

export type App = ReturnType<typeof createApp>;
export type Client = ReturnType<typeof createClient>;

/** Set-Cookie を保持して次のリクエストに付ける簡易クライアント */
export function createClient(app: App) {
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
    // biome-ignore lint/suspicious/noExplicitAny: テストでは応答の形を気にせず読む
    return { status: res.status, body: (await res.json()) as any, headers: res.headers };
  };
}

/**
 * API のテストの準備。テストごとに、メモリの保存先と新しいアプリを作る（beforeEach を登録する）。
 * 返す t のプロパティはテストごとに作り直されるので、テストの中で t.repo のように読む
 */
export function useApiTest() {
  const t = {
    repo: undefined as unknown as MemoryRepository,
    storage: undefined as unknown as MemoryPhotoStorage,
    app: undefined as unknown as App,
    /** 二つ名の抽選に使う乱数を、テストから順に指定する（無くなったら 0） */
    epithets: [] as number[],
    /** 結果整合の読み取りを待つ間に差し込む動き（抽選の確定など）。既定は何もしない */
    settle: async () => {},
    /** 未使用の QR のトークンを 1 つ作る */
    issueToken: async () => {
      const [token] = await t.repo.createTokens([`tok${++tokenSeq}`.padEnd(22, "x")], "2026-01-01T00:00:00.000Z");
      return token!.token;
    },
    /** QR で名前を登録した参加者。epithets を渡すと、その二つ名の抽選結果で登録する */
    register: async (name: string, epithets?: number[]) => {
      const token = await t.issueToken();
      if (epithets) t.epithets = epithets;
      const request = createClient(t.app);
      const reg = await request("POST", "/api/auth/register", { token, name });
      return { request, userId: reg.body.user.userId as string };
    },
    /** 管理者としてログインした簡易クライアント */
    adminClient: async () => {
      const request = createClient(t.app);
      await request("POST", "/api/admin/login", { password: ADMIN_PASSWORD });
      return request;
    },
  };
  let tokenSeq = 0;

  beforeEach(() => {
    t.repo = new MemoryRepository();
    t.storage = new MemoryPhotoStorage();
    t.epithets = [];
    t.settle = async () => {};
    let id = 0;
    t.app = createApp({
      repo: t.repo,
      storage: t.storage,
      signer: testSigner,
      sessionSecret: "test-secret",
      adminPassword: ADMIN_PASSWORD,
      secureCookies: true,
      // 二つ名の抽選結果をテストから指定できるようにする（未指定なら 0）
      randomInt: () => t.epithets.shift() ?? 0,
      // 結果整合の読み取りを待たない（メモリ実装はすぐ反映される）。待つ間の動きはテストから差し込む
      settle: () => t.settle(),
      // 本番の ULID と同じく、文字列順が発行順になるようにする
      newId: () => `ID${String(++id).padStart(4, "0")}`,
    });
  });

  return t;
}
