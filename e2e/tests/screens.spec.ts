import { expect, type Page, test } from "@playwright/test";
import { type AdminApi, adminApi, adminPage, participant, unique, updateSettings, useDefaultSettings } from "./helpers";

/**
 * 画面全体にかかわるもの（#271）：言語の切り替え、スマホの幅、以前の URL、QR の印刷、入れた HTML を文字のまま出すこと。
 * docs/e2e-tests.md の 3 章「公開・設定・移行・言語・景品・スケジュール」と 4 章。
 * 準備のデータは API で作り、確かめたい流れだけを画面から操作する
 */
useDefaultSettings();

let admin: AdminApi;
test.beforeAll(async () => {
  admin = await adminApi();
});
// beforeAll のログインに失敗したときは何もしない（本当の原因のエラーを、ここのエラーで隠さない）
test.afterAll(async () => {
  await admin?.dispose();
});

/** テストのたびに、開いたブラウザを閉じ、開催中のゲームを止める（ほかのテストが開始できるように） */
test.afterEach(async ({ browser }) => {
  for (const context of browser.contexts()) await context.close();
  if (!admin) return;
  for (const g of (await admin.get("/admin/games")).games) {
    if (g.status === "open" && !g.roundId) await admin.post(`/admin/games/${g.gameId}/stop`);
  }
});

/** 画面が横にはみ出していない（横にスクロールしない） */
const fitsWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("P1 日本語・English の切り替えがその場で効き、再読み込みしても保たれる。入れた内容と二つ名は訳さない", async ({
  browser,
}) => {
  const a = await participant(browser, admin, unique("言語 見る"));
  const prizeName = unique("E2E 言語の景品");
  await admin.post("/admin/prizes", { name: prizeName, quantity: 1, positions: [1] });
  await updateSettings(admin, { prizesVisible: true });
  const { page } = a;
  await page.goto("/");
  const tabbar = page.locator("nav.tabbar");
  await expect(tabbar.getByRole("link", { name: "ホーム" })).toBeVisible();

  await page.getByRole("group", { name: "Language / 言語" }).getByRole("button", { name: "English" }).click();
  await expect(tabbar.getByRole("link", { name: "Home" })).toBeVisible();
  await expect(tabbar.getByRole("link", { name: "Everyone" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  // 名前と二つ名は、入れたまま（訳さない）
  await expect(page.locator(".profile .name")).toHaveText(a.user.name);
  await expect(page.locator(".profile .epithet")).toHaveText(`〈${a.user.epithet}〉`);

  // 再読み込みしても英語のまま。幹事が入れた景品の名前は訳さない
  await page.reload();
  await expect(tabbar.getByRole("link", { name: "Home" })).toBeVisible();
  await tabbar.getByRole("link", { name: "Event info" }).click();
  await expect(page.getByRole("heading", { name: "Event info" })).toBeVisible();
  await expect(page.locator(".prize-list-item", { hasText: prizeName })).toBeVisible();

  // 日本語に戻せる
  await tabbar.getByRole("link", { name: "Home" }).click();
  await page.getByRole("group", { name: "Language / 言語" }).getByRole("button", { name: "日本語" }).click();
  await expect(tabbar.getByRole("link", { name: "ホーム" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
});

test("P1 スマホの幅で、ホーム・みんなの写真・ゲーム・イベント情報が横にはみ出さず、下のタブで移れる", async ({
  browser,
}) => {
  const { page } = await participant(browser, admin, "スマホ 見る");
  await updateSettings(admin, { rankingVisible: true, scheduleVisible: true });
  const tabbar = page.locator("nav.tabbar");
  const check = async (path: RegExp, heading?: string) => {
    await expect(page).toHaveURL(path);
    if (heading) await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    expect(await fitsWidth(page), `${page.url()} が横にはみ出している`).toBe(true);
    // 下のタブは画面の中に収まる
    const box = await tabbar.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
    expect(box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  };

  await page.goto("/");
  await expect(page.locator(".profile .name")).toHaveText("スマホ 見る");
  await check(/\/$/);
  await tabbar.getByRole("link", { name: "みんなの写真" }).click();
  await check(/\/gallery$/, "みんなの写真");
  await tabbar.getByRole("link", { name: "イベント情報" }).click();
  await check(/\/standings$/, "イベント情報");
  await page.getByRole("tab", { name: "ランキング" }).click();
  await expect(page.locator(".ranking-table")).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
  // ゲームの画面は、お知らせから開く（開催中でなければ案内が出る）
  await page.goto("/game");
  await check(/\/game$/);
  await tabbar.getByRole("link", { name: "ホーム" }).click();
  await check(/\/$/);
});

test("P2 以前の URL（/quiz・/favorites・/admin/quizzes）を開くと、今の画面に移る", async ({ browser }) => {
  const { page } = await participant(browser, admin, "移転 見る");
  await page.goto("/quiz");
  await expect(page).toHaveURL(/\/game$/);
  await page.goto("/favorites");
  await expect(page).toHaveURL(/\/gallery$/);
  await expect(page.getByRole("heading", { name: "みんなの写真" })).toBeVisible();

  const { page: adm } = await adminPage(browser);
  await adm.goto("/admin/quizzes");
  await expect(adm).toHaveURL(/\/admin\/games$/);
});

test("P2 QR の印刷ページを印刷の見た目にしても、QR・通し番号・日英の案内が欠けず、カードが途中で切れない", async ({
  browser,
}) => {
  const { tokens } = await admin.post("/admin/tokens", { count: 1 });
  const label: string = tokens[0].label;
  const { page: adm } = await adminPage(browser);
  // 未使用の分だけを出す（使用済みの多い環境でも軽く）
  await adm.goto("/admin/tokens/print?filter=unbound");
  const card = adm.locator(".qr-card").filter({ has: adm.getByText(`No. ${label}`, { exact: true }) });
  await expect(card.locator("img.qr")).toBeVisible();

  await adm.emulateMedia({ media: "print" });
  // 印刷のボタンなどは出さない
  await expect(adm.locator(".print-toolbar")).toBeHidden();
  const qr = card.locator("img.qr");
  await expect(qr).toBeVisible();
  expect(await qr.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(card.getByText(`No. ${label}`, { exact: true })).toBeVisible();
  await expect(card.getByText("スマホのカメラで読み込んでください")).toBeVisible();
  await expect(card.getByText("Scan with your phone’s camera")).toBeVisible();
  await expect(card).toHaveCSS("break-inside", "avoid");
  // PDF にできる（Chromium の印刷）
  expect((await adm.pdf({ format: "A4" })).byteLength).toBeGreaterThan(0);
});

test("P2 名前・ゲームの説明・景品名に入れた HTML は、文字のまま出て、スクリプトは動かない", async ({ browser }) => {
  const name = unique("<i>斜</i>&amp;");
  const description = `<img src=x onerror="window.__xss=1">説明`;
  const gameName = unique("<b>太字</b>のクイズ");
  const prizeName = unique("<script>window.__xss=1</script>景品");
  const a = await participant(browser, admin, name);
  const { game } = await admin.post("/admin/games", {
    format: "quiz",
    name: gameName,
    description,
    choices: [
      { text: "<u>はい</u>", points: 10 },
      { text: "いいえ", points: 0 },
    ],
  });
  await admin.post(`/admin/games/${game.gameId}/open`);
  await admin.post("/admin/prizes", { name: prizeName, quantity: 1, positions: [1] });
  await updateSettings(admin, { rankingVisible: true, prizesVisible: true });
  const { page } = a;
  const injected = async (p: Page) => {
    expect(await p.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    await expect(p.locator('img[src="x"], main b, main i, main u, main script')).toHaveCount(0);
  };

  await page.goto("/");
  await expect(page.locator(".profile .name")).toHaveText(name);
  await page.goto("/game");
  await expect(page.locator(".quiz-text")).toHaveText(description);
  await expect(page.getByRole("button", { name: "<u>はい</u>" })).toBeVisible();
  await injected(page);
  await page.goto("/standings");
  await expect(page.locator(".ranking-table tbody tr", { hasText: name })).toBeVisible();
  await page.getByRole("tab", { name: "景品" }).click();
  await expect(page.locator(".prize-list-item h3", { hasText: prizeName })).toHaveText(prizeName);
  await injected(page);

  // 幹事の画面でも同じ
  const { page: adm } = await adminPage(browser);
  await adm.goto("/admin/users");
  await expect(adm.locator("tbody tr", { hasText: name })).toBeVisible();
  await adm.goto("/admin/games");
  await expect(adm.getByRole("heading", { name: game.name, exact: true })).toBeVisible();
  await adm.goto("/admin/prizes");
  await expect(adm.getByRole("heading", { name: prizeName, exact: true })).toBeVisible();
  await injected(adm);
});
