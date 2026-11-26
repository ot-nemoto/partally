import { readFileSync } from "node:fs";
import { buildDataArchive } from "@partally/shared/data-archive";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { contentSecurityPolicy } from "../../infra/lib/csp.js";
import {
  type AdminApi,
  adminApi,
  choosePhoto,
  issueToken,
  jpeg,
  PHONE,
  PREVIEW_URL,
  postPhoto,
  unique,
  updateSettings,
  useDefaultSettings,
} from "./helpers";

/**
 * 本番で付けている読み込み元を絞る CSP（infra/lib/csp.ts の contentSecurityPolicy()）を、CloudFront の代わりに画面の
 * 応答へ付けて、主な流れが違反なく動くことを確かめる（CSP に引っかかる変更に気づくため。#227 で、本番のログを見る代わりに
 * これで確かめてから強制に移した）。Chromium と WebKit（iPhone の Safari と同じエンジン）の両方で流す（playwright.config.ts）。
 * 開発用のサーバはインラインのスクリプトを入れるので、本番と同じビルドの画面（vite preview）を開く。
 * E2E_BASE_URL を付けたときは、その環境の画面を開く（本番と同じビルド）
 */
const POLICY = contentSecurityPolicy("ap-northeast-1");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "admin";

useDefaultSettings();

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

/**
 * CSP を付けて画面を開くブラウザ。違反は、画面の securitypolicyviolation とコンソールから集める。
 * Worker（HEIC の変換）の中の違反は画面の securitypolicyviolation には出ないので、変換が止まって送れないこと（アップロード数）で気づく
 */
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
    ...(await page
      .evaluate(() => window.__cspViolations ?? [])
      .catch((e: Error) => {
        // 画面を移っている途中で読めなかったときだけ、記録なしとする（ほかの失敗は隠さない）
        if (/Execution context was destroyed/.test(e.message)) return [];
        throw e;
      })),
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

/** 画面の画像が読み込めている（CSP で止められると naturalWidth が 0 のまま）。画面の外で遅れて読む画像は含めない */
async function expectImagesLoaded(page: Page, selector: string) {
  const images = page.locator(selector);
  await expect(images.first()).toBeVisible();
  await expect
    .poll(() => images.evaluateAll((els) => els.every((e) => (e as HTMLImageElement).naturalWidth > 0)))
    .toBe(true);
}

/** このテストで開いたブラウザ（テストの終わりに閉じる） */
let contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts) await c.close();
  contexts = [];
  // 開催中のゲームを残さない（ほかのテストが開始できるように）
  for (const g of (await admin.get("/admin/games")).games) {
    if (g.status === "open" && !g.roundId) await admin.post(`/admin/games/${g.gameId}/stop`);
  }
});

/** CSP を付けた参加者のブラウザ。登録は API で行う */
async function cspParticipant(browser: Browser, name: string) {
  const csp = await cspContext(browser);
  contexts.push(csp.context);
  const res = await csp.page.request.post("/api/auth/register", {
    data: { token: await issueToken(admin), name, pin: "1357" },
  });
  expect(res.ok()).toBe(true);
  return csp;
}

/** CSP を付けた幹事のブラウザ。画面からログインする */
async function cspAdmin(browser: Browser) {
  const csp = await cspContext(browser, { width: 1200, height: 900 });
  contexts.push(csp.context);
  await csp.page.goto("/admin/login");
  await csp.page.locator("input[type=password]").fill(ADMIN_PASSWORD);
  await csp.page.locator("button[type=submit]").click();
  await csp.page.waitForURL(/\/admin(\/users)?$/);
  expect(await csp.violations()).toEqual([]);
  return csp;
}

test("CSP 参加者：登録・写真（JPEG と HEIC）の投稿・ギャラリー・各画面で違反が出ない", async ({ browser }) => {
  const csp = await cspContext(browser);
  contexts.push(csp.context);
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
  await choosePhoto(page, { name: "photo.jpg", mimeType: "image/jpeg", buffer: await jpeg(page) });
  await expect.poll(uploadCount, { timeout: 20_000 }).toBe(1);
  // HEIC を読めない Chromium では、heic2any（blob: の Worker と new Function）で JPEG に変換してから送る
  await choosePhoto(page, {
    name: "IMG_0001.HEIC",
    mimeType: "image/heic",
    buffer: readFileSync(new URL("../fixtures/sample.heic", import.meta.url)),
  });
  await expect.poll(uploadCount, { timeout: 30_000 }).toBe(2);
  await expect(page.locator(".error")).toHaveCount(0);
  expect(await violations()).toEqual([]);

  // 承認して、ギャラリーで自分の写真の画像（/photos の URL）が出ることを確かめる。
  // ほかのテストの写真も並ぶ（画面の外のものは遅れて読む）ので、自分の写真だけを見る
  const { photos } = await (await page.request.get("/api/photos/mine")).json();
  const mine: { photoId: string }[] = photos.filter((p: { status: string }) => p.status === "pending");
  expect(mine).toHaveLength(2);
  for (const p of mine) await admin.post(`/admin/photos/${p.photoId}/approve`);
  await page.goto("/gallery");
  await expectImagesLoaded(page, mine.map((p) => `main img[src*="${p.photoId}"]`).join(", "));
  expect(await violations()).toEqual([]);
  // 押すと拡大して、本体の画像が出る
  await page.locator(`main .photo-tile:has(img[src*="${mine[0]!.photoId}"]) button`).first().click();
  await expectImagesLoaded(page, "dialog.lightbox img");
  expect(await violations()).toEqual([]);

  await visitAll(page, violations, ["/", "/mine", "/game", "/standings"]);
});

test("CSP 管理画面：ログイン・各画面・QR の印刷・データの書き出しで違反が出ない", async ({ browser }) => {
  const { page, violations } = await cspAdmin(browser);

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

test("CSP 画像付きのゲーム・景品を作り、画像付きの ZIP を取り込み、参加者がクイズに答えて景品を見ても違反が出ない", async ({
  browser,
}) => {
  const { page: adm, violations: admViolations } = await cspAdmin(browser);

  // 問題と選択肢に画像を付けたクイズを、管理画面で作る（画像は S3 へ署名付き POST で送る）
  const quizName = unique("CSP 画像クイズ").normalize("NFKC");
  await adm.goto("/admin/games");
  await adm.getByRole("button", { name: "ゲームを作る" }).click();
  const form = adm.locator("dialog.game-dialog[open]");
  await form.getByLabel("名前", { exact: true }).fill(quizName);
  await form
    .locator("input[type=file]")
    .first()
    .setInputFiles({ name: "question.jpg", mimeType: "image/jpeg", buffer: await jpeg(adm, "#8e44ad") });
  for (const [i, text] of ["海", "山", "川"].entries()) {
    await form.getByRole("textbox", { name: new RegExp(`^選択肢 ${i + 1}`) }).fill(text);
  }
  await form
    .locator(".field", { hasText: "選択肢 1 の画像" })
    .locator("input[type=file]")
    .setInputFiles({ name: "choice.jpg", mimeType: "image/jpeg", buffer: await jpeg(adm, "#16a085") });
  const save = form.getByRole("button", { name: "保存" });
  await expect(save).toBeEnabled({ timeout: 20_000 });
  await save.click();
  await expect(form).toHaveCount(0, { timeout: 20_000 });
  expect(await admViolations()).toEqual([]);

  // 画像付きの景品を、管理画面で作る（1 位に割り当てる）
  const prizeName = unique("CSP 画像の景品");
  await adm.goto("/admin/prizes");
  await adm.getByRole("button", { name: "景品を登録" }).click();
  const prizeDialog = adm.locator("dialog[open]");
  await prizeDialog.getByLabel("名前").fill(prizeName);
  await prizeDialog.getByRole("textbox", { name: /^数量/ }).fill("1");
  await prizeDialog.getByPlaceholder("例: 1, 3, 5-10").fill("1");
  await prizeDialog
    .locator("input[type=file]")
    .setInputFiles({ name: "prize.jpg", mimeType: "image/jpeg", buffer: await jpeg(adm, "#27ae60") });
  await prizeDialog.getByRole("button", { name: "保存" }).click();
  await expect(prizeDialog).toHaveCount(0, { timeout: 20_000 });
  await expect(adm.locator("main")).toContainText(prizeName);
  expect(await admViolations()).toEqual([]);

  // 画像付きの景品の入った ZIP を取り込む（ZIP を読む処理を遅れて読み込み、画像を縮小して S3 へ送る）
  const importedPrize = unique("CSP 取り込んだ景品");
  const zip = buildDataArchive(
    { prizes: [{ name: importedPrize, quantity: 1, positions: [], image: await jpeg(adm, "#2980b9") }] },
    new Date().toISOString(),
  );
  await adm.goto("/admin/data");
  const chooser = adm.waitForEvent("filechooser");
  await adm.getByRole("button", { name: "ファイルを選ぶ" }).click();
  await (await chooser).setFiles({ name: "data.zip", mimeType: "application/zip", buffer: Buffer.from(zip) });
  const importDialog = adm.locator("dialog[open]");
  await importDialog.getByRole("button", { name: "取り込む" }).click();
  await expect(importDialog).toHaveCount(0, { timeout: 60_000 });
  await expect(adm.getByText("取り込みました。")).toBeVisible();
  expect(await admViolations()).toEqual([]);
  const prizes: { name: string; imageId?: string }[] = (await admin.get("/admin/prizes")).prizes;
  expect(prizes.find((p) => p.name === importedPrize)?.imageId).toBeTruthy();

  // 参加者：画像付きのクイズに答え、景品の画像を見る
  const game = (await admin.get("/admin/games")).games.find((g: { name: string }) => g.name === quizName);
  await admin.post(`/admin/games/${game.gameId}/open`);
  await updateSettings(admin, { prizesVisible: true, rankingVisible: true });
  const { page, violations } = await cspParticipant(browser, "CSP 回答");
  await page.goto("/game");
  await expectImagesLoaded(page, "main img");
  await page.locator(".quiz-choices button", { hasText: "海" }).click();
  await page.getByRole("button", { name: "決定" }).click();
  await expect(page.locator(".game-done-stamp")).toBeVisible();
  expect(await violations()).toEqual([]);

  await page.goto("/standings");
  await page.getByRole("tab", { name: "景品" }).click();
  // ほかのテストの景品も並ぶので、画面の外で遅れて読まないよう、この景品を画面に入れてから確かめる
  const prizeImage = page.locator(`.prize-list-item:has-text("${prizeName}") img`);
  await prizeImage.scrollIntoViewIfNeeded();
  await expectImagesLoaded(page, `.prize-list-item:has-text("${prizeName}") img`);
  expect(await violations()).toEqual([]);

  // 写真を拡大する（ギャラリーの拡大は参加者のテストで確かめる。ここでは自分の写真の画面から）
  const photoId = await postPhoto(page);
  await admin.post(`/admin/photos/${photoId}/approve`);
  await page.goto("/mine");
  await page.locator(`main .photo-tile:has(img[src*="${photoId}"]) button`).first().click();
  await expectImagesLoaded(page, "dialog.lightbox img");
  expect(await violations()).toEqual([]);
});
