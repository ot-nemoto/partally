import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  request,
} from "@playwright/test";

export const BASE_URL = "http://localhost:5173";
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
