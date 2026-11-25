import { readFileSync } from "node:fs";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { reportOnlyCsp } from "../../infra/lib/csp.js";
import { type AdminApi, adminApi, issueToken, jpeg, PHONE } from "./helpers";

/**
 * 読み込み元を絞る CSP（本番では Report-Only で付けている reportOnlyCsp()）を、CloudFront の代わりに画面の応答へ
 * Content-Security-Policy として付けて、主な流れが違反なく動くことを確かめる（#227 で強制に切り替える前の確認と、
 * CSP に引っかかる変更に気づくため）。開発用のサーバはインラインのスクリプトを入れるので、本番と同じビルドの画面
 * （vite preview、playwright.config.ts）を開く
 */
const PREVIEW_URL = "http://localhost:4173";
const POLICY = reportOnlyCsp("ap-northeast-1");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "admin";

let admin: AdminApi;
test.beforeAll(async () => {
  admin = await adminApi();
});
test.afterAll(async () => {
  await admin.dispose();
});

declare global {
  interface Window {
    __cspViolations: string[];
  }
}

/** CSP を付けて画面を開くブラウザ。違反は securitypolicyviolation とコンソールの両方から集める */
async function cspContext(browser: Browser, viewport = PHONE) {
  const context = await browser.newContext({ baseURL: PREVIEW_URL, viewport, locale: "ja-JP" });
  await context.route(`${PREVIEW_URL}/**`, async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": POLICY } });
  });
  await context.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  const consoleViolations: string[] = [];
  const page = await context.newPage();
  page.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) consoleViolations.push(m.text());
  });
  /** 開いた画面で起きた違反（画面を移ると securitypolicyviolation の記録は消えるので、移る前にも呼ぶ） */
  const violations = async () => [
    ...consoleViolations,
    ...(await page.evaluate(() => window.__cspViolations ?? []).catch(() => [])),
  ];
  return { context, page, violations };
}

/** 画面を順に開き、それぞれで違反が出ていないことを確かめる */
async function visitAll(page: Page, violations: () => Promise<string[]>, paths: string[]) {
  for (const path of paths) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    expect(await violations(), path).toEqual([]);
  }
}

async function chooseFile(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "写真を選ぶ" }).click();
  await (await chooser).setFiles(file);
}

/** 画面の画像が読み込めている（CSP で止められると naturalWidth が 0 のまま） */
async function expectImagesLoaded(page: Page, selector: string) {
  const images = page.locator(selector);
  await expect(images.first()).toBeVisible();
  await expect
    .poll(() => images.evaluateAll((els) => els.every((e) => (e as HTMLImageElement).naturalWidth > 0)))
    .toBe(true);
}

let context: BrowserContext | undefined;
test.afterEach(async () => {
  await context?.close();
  context = undefined;
});

test("CSP 参加者：登録・写真（JPEG と HEIC）の投稿・ギャラリー・各画面で違反が出ない", async ({ browser }) => {
  const csp = await cspContext(browser);
  context = csp.context;
  const { page, violations } = csp;

  const token = await issueToken(admin);
  await page.goto(`/q/${token}`);
  await page.getByLabel("お名前").fill("CSP 確認");
  await page.getByLabel(/暗証番号（数字/).fill("2468");
  await page.getByLabel("暗証番号（確認のため、もう一度）").fill("2468");
  await page.getByRole("button", { name: "登録する" }).click();
  await page.getByRole("link", { name: "はじめる" }).click();
  await expect(page.locator(".profile .name")).toHaveText("CSP 確認");

  const uploadCount = async () => (await (await page.request.get("/api/me")).json()).user.uploadCount;
  await chooseFile(page, { name: "photo.jpg", mimeType: "image/jpeg", buffer: await jpeg(page) });
  await expect.poll(uploadCount, { timeout: 20_000 }).toBe(1);
  // HEIC を読めない Chromium では、heic2any（blob: の Worker と new Function）で JPEG に変換してから送る
  await chooseFile(page, {
    name: "IMG_0001.HEIC",
    mimeType: "image/heic",
    buffer: readFileSync(new URL("../fixtures/sample.heic", import.meta.url)),
  });
  await expect.poll(uploadCount, { timeout: 30_000 }).toBe(2);
  await expect(page.locator(".error")).toHaveCount(0);
  expect(await violations()).toEqual([]);

  // 承認して、ギャラリーと自分の写真で画像（/photos の署名付き URL）が出ることを確かめる
  const userId = (await (await page.request.get("/api/me")).json()).user.userId;
  const { photos } = await admin.get("/admin/photos?status=pending");
  for (const p of photos.filter((p: { uploaderId: string }) => p.uploaderId === userId)) {
    await admin.post(`/admin/photos/${p.photoId}/approve`);
  }
  await page.goto("/gallery");
  await expectImagesLoaded(page, "main img");
  expect(await violations()).toEqual([]);

  await visitAll(page, violations, ["/", "/mine", "/game", "/standings"]);
});

test("CSP 管理画面：ログイン・各画面・QR の印刷・データの書き出しで違反が出ない", async ({ browser }) => {
  const csp = await cspContext(browser, { width: 1200, height: 900 });
  context = csp.context;
  const { page, violations } = csp;

  await page.goto("/admin/login");
  await page.locator("input[type=password]").fill(ADMIN_PASSWORD);
  await page.locator("button[type=submit]").click();
  await page.waitForURL(/\/admin(\/users)?$/);
  expect(await violations()).toEqual([]);

  await visitAll(page, violations, [
    "/admin/users",
    "/admin/ranking",
    "/admin/trend",
    "/admin/tokens",
    "/admin/photos",
    "/admin/games",
    "/admin/prizes",
    "/admin/schedule",
    "/admin/settings",
    "/admin/data",
  ]);

  // 書き出し（ZIP を作る処理を遅れて読み込み、blob: の URL で保存する）
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "エクスポート", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.zip$/);
  expect(await violations()).toEqual([]);

  // QR の印刷ページ（QR の画像は data: の URL）
  await issueToken(admin);
  await page.goto("/admin/tokens/print");
  await expectImagesLoaded(page, ".qr-card img.qr");
  expect(await violations()).toEqual([]);
});
