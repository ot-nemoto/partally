import { expect, type Page, test } from "@playwright/test";
import {
  type AdminApi,
  acceptConfirm,
  adminApi,
  adminPage,
  BASE_URL,
  issueToken,
  PHONE,
  participant,
  unique,
  updateSettings,
  useDefaultSettings,
} from "./helpers";

/**
 * 参加・ログイン（#267）：QR からの登録とログイン、暗証番号、紐づけの解除、1 台の端末の上限、幹事のユーザ管理・ログアウト・
 * 参加リンクのコピー、Cookie の期限。docs/e2e-tests.md の 3 章「参加・認証」「1 台の端末で複数の参加者」と 4 章。
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

/** ログインしていない、別の端末（スマホの大きさ） */
async function otherDevice(browser: import("@playwright/test").Browser, userAgent?: string): Promise<Page> {
  const context = await browser.newContext({ viewport: PHONE, locale: "ja-JP", ...(userAgent ? { userAgent } : {}) });
  return context.newPage();
}

/** 暗証番号の欄（1 回目） */
const pinField = (page: Page) => page.getByLabel(/^暗証番号（数字/);

/** 結果入力のゲームで、その人に点数を入れる（作って開始し、終了する） */
async function award(userId: string, points: number) {
  const { game } = await admin.post("/admin/games", {
    format: "result",
    name: unique("E2E 参加の大会"),
    slots: [{ name: "優勝", points, userIds: [userId] }],
  });
  await admin.post(`/admin/games/${game.gameId}/open`);
  await admin.post(`/admin/games/${game.gameId}/confirm`);
}

/** 幹事のユーザ一覧の行（名前で探す） */
const userRow = (adm: Page, name: string) => adm.locator("tbody tr", { hasText: name });

const me = async (page: Page) => (await page.request.get("/api/me")).status();

test.describe("参加・認証", () => {
  test("P1 無効な QR コードでは、登録に進めず案内が出る", async ({ browser }) => {
    const page = await otherDevice(browser);
    // 形は合っている（22 文字）が、発行していないトークン
    await page.goto("/q/E2EnotIssuedToken00000");
    await expect(page.locator(".error")).toHaveText("この QR コードは無効です。運営に声をかけてください。");
    await expect(page.getByRole("button", { name: "登録する" })).toHaveCount(0);
    await expect(pinField(page)).toHaveCount(0);
    // 形の違うトークン（途中で切れた URL など）でも、登録に進めない
    await page.goto("/q/e2e-broken");
    await expect(page.locator(".error")).toBeVisible();
    await expect(page.getByRole("button", { name: "登録する" })).toHaveCount(0);
    await expect(pinField(page)).toHaveCount(0);
  });

  test("P1 ログインしていないときに参加者・管理画面の URL を開くと、案内・ログインへ戻る", async ({ browser }) => {
    const page = await otherDevice(browser);
    for (const path of ["/", "/gallery", "/mine", "/game", "/standings"]) {
      await page.goto(path);
      await expect(page.getByText("配布された QR コードをスマホのカメラで読み込んでください。"), path).toBeVisible();
      await expect(page.locator("nav.tabbar")).toHaveCount(0);
    }
    for (const path of ["/admin", "/admin/users", "/admin/games", "/admin/settings"]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/admin\/login$/);
    }
  });

  test("P1 暗証番号を 5 回間違えるとロックされ、幹事が解除すると別の端末でログインできる（ログインしたままの端末は使える）", async ({
    browser,
  }) => {
    const a = await participant(browser, admin, unique("ロック 一"));
    const other = await otherDevice(browser);
    await other.goto(`/q/${a.token}`);
    await expect(other.getByRole("heading", { name: "暗証番号を入れてください" })).toBeVisible();
    for (let left = 4; left >= 1; left--) {
      await pinField(other).fill("0000");
      await other.getByRole("button", { name: "ログイン" }).click();
      await expect(other.locator(".error")).toHaveText(`暗証番号が違います（あと ${left} 回）。`);
    }
    await pinField(other).fill("0000");
    await other.getByRole("button", { name: "ログイン" }).click();
    await expect(other.locator(".error")).toHaveText(
      "暗証番号を続けて間違えたため、ロックしました。運営に声をかけてください。",
    );
    await expect(pinField(other)).toHaveCount(0);
    // 読み込み直しても、正しい番号を入れる欄は出ない
    await other.reload();
    await expect(other.locator(".error")).toContainText("ロックしました");
    await expect(pinField(other)).toHaveCount(0);

    // ログインしたままの端末は、そのまま使える
    await a.page.goto("/");
    await expect(a.page.locator(".profile .name")).toHaveText(a.user.name);

    // 幹事が解除する
    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/users");
    const row = userRow(adm, a.user.name);
    await expect(row).toContainText("ロック中");
    await row.getByRole("button", { name: "ロック解除" }).click();
    await acceptConfirm(adm);
    await expect(row).toContainText("設定済み");

    await other.reload();
    await pinField(other).fill("1234");
    await other.getByRole("button", { name: "ログイン" }).click();
    await expect(other).toHaveURL(/\/$/);
    await expect(other.locator(".profile .name")).toHaveText(a.user.name);
  });

  test("P1 紐づけを解除された参加者は次の操作でログアウトし、同じ QR で新しく登録でき、ポイントは引き継がない", async ({
    browser,
  }) => {
    const a = await participant(browser, admin, unique("解除 前"));
    await award(a.user.userId, 20);
    await a.page.goto("/");
    await expect(a.page.locator(".points-value")).toHaveText("20");

    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/users");
    const row = userRow(adm, a.user.name);
    await row.getByRole("button", { name: "紐づけ解除" }).click();
    await acceptConfirm(adm);
    await expect(row).toContainText("解除済み");
    await expect(row).toHaveClass(/dimmed/);

    // 次の操作（読み込み直し）で、案内の画面になる
    await a.page.reload();
    await expect(a.page.getByText("配布された QR コードをスマホのカメラで読み込んでください。")).toBeVisible();
    expect(await me(a.page)).toBe(401);

    // 同じ QR で、新しい人として登録できる（ポイントは 0 から）
    const renamed = unique("解除 後");
    await a.page.goto(`/q/${a.token}`);
    await a.page.getByLabel("お名前").fill(renamed);
    await pinField(a.page).fill("2468");
    await a.page.getByLabel("暗証番号（確認のため、もう一度）").fill("2468");
    await a.page.getByRole("button", { name: "登録する" }).click();
    await a.page.getByRole("link", { name: "はじめる" }).click();
    await expect(a.page.locator(".profile .name")).toHaveText(renamed);
    await expect(a.page.locator(".points-value")).toHaveText("0");
    await adm.reload();
    await expect(userRow(adm, renamed)).toContainText("登録済み");
    await expect(userRow(adm, a.user.name)).toContainText("解除済み");
  });

  test("P1 LINE などのアプリ内ブラウザで開くと、標準のカメラで読み込むよう注意が出る", async ({ browser }) => {
    const token = await issueToken(admin);
    const notice =
      "アプリ内のブラウザで開いています。次回以降もログイン状態を保つには、スマホ標準のカメラで QR コードを読み込んでください。";
    const line = await otherDevice(
      browser,
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/13.17.0",
    );
    await line.goto(`/q/${token}`);
    await expect(line.getByRole("button", { name: "登録する" })).toBeVisible();
    await expect(line.locator(".notice")).toHaveText(notice);

    // ふつうのブラウザでは出ない
    const normal = await otherDevice(browser);
    await normal.goto(`/q/${token}`);
    await expect(normal.getByRole("button", { name: "登録する" })).toBeVisible();
    await expect(normal.locator(".notice")).toHaveCount(0);
  });

  test("P1 紐づけを解除した人は、管理画面のランキングで薄く出て、参加者のランキングと景品の順位には数えない", async ({
    browser,
  }) => {
    // 解除する人は、いちばん多いポイントにする（数えると 1 位になる）
    const top = await participant(browser, admin, unique("解除 一位"));
    await award(top.user.userId, 100);
    await admin.post(`/admin/users/${top.user.userId}/unbind`);
    const prizeName = unique("E2E 解除の景品");
    await admin.post("/admin/prizes", { name: prizeName, quantity: 1, positions: [1] });
    await updateSettings(admin, { rankingVisible: true, prizesVisible: true });

    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/ranking");
    const row = adm.locator(".ranking-table tbody tr", { hasText: top.user.name });
    await expect(row).toHaveClass(/dimmed/);
    await expect(row).toContainText("（解除済み）");
    await expect(row).not.toContainText(prizeName);
    // 1 番目の景品は、解除済みの人を除いて 1 番目の人に付く
    await expect(adm.locator(".ranking-table tbody tr:not(.dimmed)").first()).toContainText(prizeName);

    const viewer = await participant(browser, admin, "解除 見る");
    await viewer.page.goto("/standings");
    await expect(viewer.page.locator(".ranking-table")).toBeVisible();
    await expect(viewer.page.locator(".ranking-table")).not.toContainText(top.user.name);
    await expect(viewer.page.locator(".ranking-table tbody tr").first()).toContainText(prizeName);
    const ranking = await (await viewer.page.request.get("/api/ranking")).json();
    expect(JSON.stringify(ranking)).not.toContain(top.user.userId);
  });

  test("P2 幹事が暗証番号を消すと、次に別の端末で読み込んだ人が決め直し、その番号でログインできる", async ({
    browser,
  }) => {
    const a = await participant(browser, admin, unique("暗証 消す"));
    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/users");
    const row = userRow(adm, a.user.name);
    await row.getByRole("button", { name: "暗証番号を消す" }).click();
    await acceptConfirm(adm);
    await expect(row).toContainText("未設定");

    const other = await otherDevice(browser);
    await other.goto(`/q/${a.token}`);
    await expect(other.getByRole("heading", { name: "暗証番号を決めてください" })).toBeVisible();
    await pinField(other).fill("5678");
    await other.getByLabel("暗証番号（確認のため、もう一度）").fill("5678");
    await other.getByRole("button", { name: "決めてログイン" }).click();
    await expect(other).toHaveURL(/\/$/);
    await expect(other.locator(".profile .name")).toHaveText(a.user.name);
    await adm.reload();
    await expect(userRow(adm, a.user.name)).toContainText("設定済み");

    // さらに別の端末では、決め直した番号を聞かれる（前の番号では入れない）
    const third = await otherDevice(browser);
    await third.goto(`/q/${a.token}`);
    await expect(third.getByRole("heading", { name: "暗証番号を入れてください" })).toBeVisible();
    await pinField(third).fill("1234");
    await third.getByRole("button", { name: "ログイン" }).click();
    await expect(third.locator(".error")).toContainText("暗証番号が違います");
    await pinField(third).fill("5678");
    await third.getByRole("button", { name: "ログイン" }).click();
    await expect(third).toHaveURL(/\/$/);
  });

  test("P2 幹事が名前・二つ名を変えると参加者の表示に出て、ほかの人と同じ二つ名にはできない", async ({ browser }) => {
    const a = await participant(browser, admin, unique("変更 前"));
    const b = await participant(browser, admin, unique("変更 他"));
    const name = unique("変更 後");
    const epithet = unique("E2E の二つ名");
    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/users");
    const dialog = adm.locator("dialog[open]");
    await userRow(adm, a.user.name).getByRole("button", { name: "編集" }).click();
    await dialog.getByLabel("二つ名").fill(epithet);
    await dialog.getByLabel("名前", { exact: true }).fill(name);
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(userRow(adm, name)).toContainText(`〈${epithet}〉`);

    await a.page.goto("/");
    await expect(a.page.locator(".profile .name")).toHaveText(name);
    await expect(a.page.locator(".profile .epithet")).toHaveText(`〈${epithet}〉`);

    // ほかの人と同じ二つ名にはできない
    await userRow(adm, b.user.name).getByRole("button", { name: "編集" }).click();
    await dialog.getByLabel("二つ名").fill(epithet);
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog.locator(".error")).toHaveText("その二つ名は他の人が使っています。");
    await dialog.getByRole("button", { name: "キャンセル" }).click();
    await b.page.goto("/");
    await expect(b.page.locator(".profile .epithet")).toHaveText(`〈${b.user.epithet}〉`);
  });
});

test("P1 1 台の端末に覚えるのは 5 人までで、6 人目が登録すると、いちばん前にログインした人が外れる", async ({
  browser,
}) => {
  const first = await participant(browser, admin, unique("端末 1"));
  const { page } = first;
  const names = [first.user.name];
  for (let i = 2; i <= 6; i++) {
    const token = await issueToken(admin);
    const name = unique(`端末 ${i}`);
    const res = await page.request.post("/api/auth/register", { data: { token, name, pin: "1234" } });
    expect(res.ok()).toBe(true);
    names.push(name);
  }

  await page.goto("/");
  const buttons = page.getByRole("group", { name: "参加者の切り替え" }).getByRole("button");
  await expect(buttons).toHaveCount(5);
  await expect(page.locator(".profile .name")).toHaveText(names[5]!);
  for (const name of names.slice(1)) await expect(buttons.filter({ hasText: name })).toHaveCount(1);
  await expect(buttons.filter({ hasText: names[0]! })).toHaveCount(0);

  // 外れた人の QR は、この端末でも暗証番号を聞かれる
  await page.goto(`/q/${first.token}`);
  await expect(page.getByRole("heading", { name: "暗証番号を入れてください" })).toBeVisible();
});

test.describe("幹事", () => {
  test("P2 ログアウトすると、ログインの画面に戻り、管理画面は開けない", async ({ browser }) => {
    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/games");
    await adm.getByRole("button", { name: "ログアウト" }).click();
    await expect(adm).toHaveURL(/\/admin\/login$/);
    await adm.goto("/admin/users");
    await expect(adm).toHaveURL(/\/admin\/login$/);
    expect((await adm.request.get("/api/admin/me")).status()).toBe(401);
  });

  test("P2 QR の画面の「コピー」で、参加リンクがクリップボードに入る", async ({ browser }) => {
    const { tokens } = await admin.post("/admin/tokens", { count: 1 });
    const { token, label } = tokens[0] as { token: string; label: string };
    const { context, page: adm } = await adminPage(browser);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE_URL });
    await adm.goto("/admin/tokens");
    const copy = adm.getByRole("button", { name: `${label} の参加リンクをコピー`, exact: true });
    await copy.click();
    await expect(copy).toHaveText("コピーしました");
    expect(await adm.evaluate(() => navigator.clipboard.readText())).toBe(`${BASE_URL}/q/${token}`);
  });

  test("P2 参加者のログインは 30 日、幹事のログインは 12 時間で切れる（Cookie の期限）", async ({ browser }) => {
    const a = await participant(browser, admin, "期限 見る");
    const now = Date.now() / 1000;
    const cookie = async (context: import("@playwright/test").BrowserContext, name: string) => {
      const found = (await context.cookies()).find((c) => c.name === name);
      expect(found, name).toBeDefined();
      return found!;
    };
    const session = await cookie(a.context, "session");
    expect(session.httpOnly).toBe(true);
    expect(session.expires - now).toBeGreaterThan(30 * 24 * 3600 - 120);
    expect(session.expires - now).toBeLessThanOrEqual(30 * 24 * 3600 + 5);
    const { context } = await adminPage(browser);
    const adminSession = await cookie(context, "admin_session");
    expect(adminSession.httpOnly).toBe(true);
    expect(adminSession.sameSite).toBe("Strict");
    expect(adminSession.expires - now).toBeGreaterThan(12 * 3600 - 120);
    expect(adminSession.expires - now).toBeLessThanOrEqual(12 * 3600 + 5);
  });
});
