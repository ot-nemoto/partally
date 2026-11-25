import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  request,
  test,
} from "@playwright/test";
import { DEFAULT_SETTINGS } from "../../api/src/repository.js";
import { REMOTE_URL } from "./target";

export { REMOTE_URL };
export const BASE_URL = REMOTE_URL ?? "http://localhost:5173";
/** ローカルでしか確かめられないテストを skip するときの理由 */
export const LOCAL_ONLY = "ローカル開発環境でしか確かめられないため、E2E_BASE_URL を付けたときは流さない";

/**
 * 実行ごとに変わる名前。データの入った環境には、前に流したときのデータや同じ名前のデータが残っているので、
 * 画面で名前を使って探すデータ（ゲーム・景品・スケジュール・参加者）には、これを付けて重ならないようにする
 */
const RUN_ID = Date.now().toString(36).slice(-5);
export function unique(name: string): string {
  return `${name} ${RUN_ID}`;
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "admin";

/** スマホの画面の大きさ（参加者） */
export const PHONE = { width: 390, height: 844 };

/**
 * 幹事の API（準備のデータは画面を通さず API で作る）。ログインした Cookie を持つ。
 * 応答が 2xx でなければ、中身を添えて失敗にする
 */
export async function adminApi() {
  const ctx = await request.newContext({ baseURL: BASE_URL });
  const login = await ctx.post("/api/admin/login", { data: { password: ADMIN_PASSWORD } });
  expect(login.ok()).toBe(true);
  return wrap(ctx);
}

function wrap(ctx: APIRequestContext) {
  const send = async (method: string, path: string, data?: unknown) => {
    const res = await ctx.fetch(`/api${path}`, { method, data: data ?? (method === "GET" ? undefined : {}) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${JSON.stringify(body)}`);
    return body;
  };
  return {
    get: (path: string) => send("GET", path),
    post: (path: string, data?: unknown) => send("POST", path, data),
    put: (path: string, data?: unknown) => send("PUT", path, data),
    del: (path: string) => send("DELETE", path),
    dispose: () => ctx.dispose(),
  };
}

export type AdminApi = Awaited<ReturnType<typeof adminApi>>;

/** QR コードを 1 件発行し、トークンを返す */
export async function issueToken(admin: AdminApi): Promise<string> {
  const { tokens } = await admin.post("/admin/tokens", { count: 1 });
  return tokens[0].token;
}

/** 設定の一部を変える（ほかの項目は今のまま） */
export async function updateSettings(admin: AdminApi, changes: Record<string, unknown>) {
  const { settings } = await admin.get("/admin/settings");
  await admin.put("/admin/settings", { ...settings, ...changes });
}

/**
 * テストの前提の設定（既定値）にそろえる。spec の初めに 1 回呼ぶ。
 * - 初めに今の設定を取っておき、既定値にそろえる
 * - テストが updateSettings() で変えた設定は、テストのたびに既定値へ戻す（後のテストに持ち越さない）
 * - 終わったら、取っておいた設定に戻す（データの入った環境の設定を変えたままにしない）
 */
export function useDefaultSettings() {
  let api: AdminApi;
  let original: Record<string, unknown> | undefined;
  test.beforeAll(async () => {
    api = await adminApi();
    original = (await api.get("/admin/settings")).settings;
    await api.put("/admin/settings", DEFAULT_SETTINGS);
  });
  // beforeAll のログインに失敗したときは何もしない（本当の原因のエラーを、ここのエラーで隠さない）
  test.afterEach(async () => {
    if (api) await api.put("/admin/settings", DEFAULT_SETTINGS);
  });
  test.afterAll(async () => {
    if (!api) return;
    if (original) await api.put("/admin/settings", original);
    await api.dispose();
  });
}

/**
 * スケジュールの項目を、タイトルで探して消す（テストが作った項目だけ）。スケジュールは 1 つの時間軸を共有し、
 * 残すと同じ時刻に流すたびに列が増え（上限 50 列）、後のテストの「いま」「つぎ」も変わるので、テストの終わりに片付ける
 */
export async function deleteScheduleItems(admin: AdminApi, titles: string[]) {
  const { items } = await admin.get("/admin/schedule");
  for (const item of items as { itemId: string; title: string }[]) {
    if (titles.includes(item.title)) await admin.del(`/admin/schedule/${item.itemId}`);
  }
}

/** 今日のその時刻（0:00 からの分と秒）。参加者の画面の時計（page.clock）に使う */
export function todayAt(minute: number, second = 0): Date {
  const d = new Date();
  d.setHours(Math.floor(minute / 60), minute % 60, second, 0);
  return d;
}

/** 参加者 1 人分のブラウザ（スマホの大きさ）。登録は API で行い、Cookie はこのブラウザに入る */
export async function participant(browser: Browser, admin: AdminApi, name: string, pin = "1234") {
  const token = await issueToken(admin);
  const context = await browser.newContext({ viewport: PHONE, locale: "ja-JP" });
  const page = await context.newPage();
  const res = await page.request.post("/api/auth/register", { data: { token, name, pin } });
  expect(res.ok()).toBe(true);
  const { user } = await res.json();
  return { context, page, token, user: user as { userId: string; name: string; epithet: string } };
}

/** 幹事のブラウザ（画面からログインする） */
export async function adminPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: "ja-JP" });
  const page = await context.newPage();
  await page.goto("/admin/login");
  await page.locator("input[type=password]").fill(ADMIN_PASSWORD);
  await page.locator("button[type=submit]").click();
  await page.waitForURL(/\/admin(\/users)?$/);
  return { context, page };
}

/** 画面内の確認ダイアログで「OK」を押す */
export async function acceptConfirm(page: Page) {
  const dialog = page.locator("dialog.confirm-dialog[open]");
  await dialog.getByRole("button", { name: "OK" }).click();
  await expect(dialog).toHaveCount(0);
}

/**
 * テスト用の JPEG（ブラウザの canvas で作る。写真・景品の画像のアップロードに使う）。
 * 大きさを省くと 320×240
 */
export async function jpeg(page: Page, color = "#c0392b", size = { width: 320, height: 240 }): Promise<Buffer> {
  const dataUrl = await page.evaluate(
    ({ fill, width, height }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#fff";
      ctx.fillRect(width / 8, height / 6, width / 3, height / 3);
      return canvas.toDataURL("image/jpeg", 0.9);
    },
    { fill: color, ...size },
  );
  return Buffer.from(dataUrl.split(",")[1]!, "base64");
}

/** 参加者の写真の一覧（自分の写真。新しい順） */
export async function myPhotos(page: Page): Promise<{ photoId: string; status: string; createdAt: string }[]> {
  return (await (await page.request.get("/api/photos/mine")).json()).photos;
}

/**
 * 写真を、画面を通さずに API で送る（準備の写真）。送り先の発行から、サムネイル・本体の送信までを画面と同じ順に行い、
 * サーバが取り込むまで待って photoId を返す。送り先の発行は短い間の上限（10 分に 30 回）に数える
 */
export async function postPhoto(page: Page, color = "#27ae60"): Promise<string> {
  const res = await page.request.post("/api/photos/upload-url", { data: {} });
  expect(res.ok()).toBe(true);
  const target = await res.json();
  const body = await jpeg(page, color);
  for (const kind of ["thumb", "full"] as const) {
    const { url, fields } = target[kind] as { url: string; fields: Record<string, string> };
    const sent = await page.request.post(url, {
      multipart: { ...fields, file: { name: "photo.jpg", mimeType: "image/jpeg", buffer: body } },
    });
    expect(sent.ok()).toBe(true);
  }
  await expect
    .poll(async () => (await myPhotos(page)).some((p) => p.photoId === target.photoId), { timeout: 30_000 })
    .toBe(true);
  return target.photoId;
}

/** 参加者のホームに出ているポイント（数字） */
export async function homePoints(page: Page): Promise<number> {
  await page.goto("/");
  return Number(await page.locator(".points-value").textContent());
}

/** ホームの「写真を選ぶ」で写真を選ぶ（file を省くと、テスト用の JPEG を選ぶ） */
export async function choosePhoto(page: Page, file?: { name: string; mimeType: string; buffer: Buffer }) {
  const chosen = file ?? { name: "photo.jpg", mimeType: "image/jpeg", buffer: await jpeg(page) };
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "写真を選ぶ" }).click();
  await (await chooser).setFiles(chosen);
}
