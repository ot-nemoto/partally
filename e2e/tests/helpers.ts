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

/**
 * テストを流す先。E2E_BASE_URL を付けると、データの入った環境（検証用の本番相当の環境など）へ向けて流す。
 * 付けなければローカル開発環境（playwright.config.ts の webServer が起動する API と web）
 */
export const REMOTE_URL = process.env.E2E_BASE_URL?.replace(/\/+$/, "") || undefined;
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
  test.afterEach(async () => {
    await api.put("/admin/settings", DEFAULT_SETTINGS);
  });
  test.afterAll(async () => {
    if (original) await api.put("/admin/settings", original);
    await api.dispose();
  });
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

/** テスト用の JPEG（ブラウザの canvas で作る。写真・景品の画像のアップロードに使う） */
export async function jpeg(page: Page, color = "#c0392b"): Promise<Buffer> {
  const dataUrl = await page.evaluate((fill) => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, 320, 240);
    ctx.fillStyle = "#fff";
    ctx.fillRect(40, 40, 120, 80);
    return canvas.toDataURL("image/jpeg", 0.9);
  }, color);
  return Buffer.from(dataUrl.split(",")[1]!, "base64");
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
