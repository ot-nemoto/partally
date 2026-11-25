import { expect, type Page, test } from "@playwright/test";
import { type AdminApi, adminApi, issueToken, jpeg, participant } from "./helpers";

/**
 * P1: 主要な連携（docs/e2e-tests.md の 3 章）。
 * 準備のデータは API で作り、確かめたい流れだけを画面から操作する
 */
let admin: AdminApi;
test.beforeAll(async () => {
  admin = await adminApi();
});
test.afterAll(async () => {
  await admin.dispose();
});

/** 同じブラウザ（端末）で、もう 1 人を登録する。登録した人が今の参加者になる */
async function registerOnSameDevice(page: Page, name: string, pin = "1234") {
  const token = await issueToken(admin);
  const res = await page.request.post("/api/auth/register", { data: { token, name, pin } });
  expect(res.ok()).toBe(true);
  const { user } = await res.json();
  return { token, user: user as { userId: string; name: string } };
}

/** 画面の上の、参加者を切り替える名前のボタン */
const switchButtons = (page: Page) => page.getByRole("group", { name: "参加者の切り替え" }).getByRole("button");
const switchButton = (page: Page, name: string) => switchButtons(page).filter({ hasText: name });

/** 幹事から見た、その参加者のアップロード数 */
async function uploadCountOf(userId: string): Promise<number> {
  const { users } = await admin.get("/admin/users");
  return users.find((u: { userId: string }) => u.userId === userId).uploadCount;
}

test.describe("1 台の端末で複数の参加者", () => {
  test("P1 2 人を登録すると名前のボタンで切り替えられ、覚えている人の QR は暗証番号なしで入れる", async ({
    browser,
  }) => {
    const parent = await participant(browser, admin, "切替 親");
    const { page } = parent;
    await registerOnSameDevice(page, "切替 子");

    // 後から登録した人が今の参加者で、その人のボタンに色が付く
    await page.goto("/");
    await expect(switchButtons(page)).toHaveCount(2);
    await expect(page.locator(".profile .name")).toHaveText("切替 子");
    await expect(switchButton(page, "切替 子")).toHaveAttribute("aria-pressed", "true");

    await switchButton(page, "切替 親").click();
    await expect(page.locator(".profile .name")).toHaveText("切替 親");
    await expect(switchButton(page, "切替 親")).toHaveAttribute("aria-pressed", "true");

    // ホーム以外の画面からも切り替えられ、同じ画面のまま開き直す
    await page.goto("/gallery");
    await switchButton(page, "切替 子").click();
    await expect(switchButton(page, "切替 子")).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(/\/gallery$/);
    expect((await (await page.request.get("/api/me")).json()).user.name).toBe("切替 子");

    // 今の参加者でなくても、この端末で覚えている人の QR なら暗証番号を聞かれない
    await page.goto(`/q/${parent.token}`);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator(".profile .name")).toHaveText("切替 親");
  });

  test("P1 送信待ちの写真は、ほかの人に切り替えた後に送られても、撮った人の写真になる", async ({ browser }) => {
    const child = await participant(browser, admin, "送信 子");
    const { page } = child;
    const parent = await registerOnSameDevice(page, "送信 親");

    // 送り先の発行を断らせて、親が撮った写真を送信待ちに残す
    const blocked = "**/api/photos/upload-url";
    await page.route(blocked, (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) }),
    );
    await page.goto("/");
    await expect(page.locator(".profile .name")).toHaveText("送信 親");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "写真を選ぶ" }).click();
    await (await chooser).setFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: await jpeg(page) });
    await expect(page.getByText("送信待ち：1 枚")).toBeVisible({ timeout: 20_000 });

    // 子に切り替えてから（切り替えより前に送られないよう、断らせたまま）、送信待ちの写真を送る
    await switchButton(page, "送信 子").click();
    await expect(page.locator(".profile .name")).toHaveText("送信 子");
    expect(await uploadCountOf(parent.user.userId)).toBe(0);
    await page.unroute(blocked);
    await page.getByRole("button", { name: "今すぐ再送" }).click();
    await expect.poll(() => uploadCountOf(parent.user.userId), { timeout: 20_000 }).toBe(1);
    expect(await uploadCountOf(child.user.userId)).toBe(0);
    await expect(page.getByText(/送信待ち|送信中/)).toHaveCount(0);
  });

  test("P1 紐づけを解除された人は外れ、使っている人が解除されると覚えているほかの人に切り替わる", async ({
    browser,
  }) => {
    const first = await participant(browser, admin, "解除 一");
    const { page } = first;
    const second = await registerOnSameDevice(page, "解除 二");
    const third = await registerOnSameDevice(page, "解除 三");

    await page.goto("/");
    await expect(switchButtons(page)).toHaveCount(3);
    await expect(page.locator(".profile .name")).toHaveText("解除 三");

    // 使っていない人の紐づけを解除してから、その人のボタンを押すと、案内が出てボタンが消える
    await admin.post(`/admin/users/${second.user.userId}/unbind`);
    let message = "";
    page.once("dialog", (d) => {
      message = d.message();
      void d.accept();
    });
    await switchButton(page, "解除 二").click();
    await expect.poll(() => message).toContain("この端末では使えなくなりました");
    await expect(switchButtons(page)).toHaveCount(2);
    await expect(switchButton(page, "解除 二")).toHaveCount(0);
    await expect(page.locator(".profile .name")).toHaveText("解除 三");

    // 使っている人の紐づけを解除すると、画面を開いたまま（ゲームの確認のときに）覚えているほかの人に切り替わる。
    // 残りが 1 人になるので、名前のボタンは出なくなる
    await admin.post(`/admin/users/${third.user.userId}/unbind`);
    await expect(page.locator(".profile .name")).toHaveText("解除 一", { timeout: 20_000 });
    await expect(switchButtons(page)).toHaveCount(0);
  });
});
