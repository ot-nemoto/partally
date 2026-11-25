import { readFileSync } from "node:fs";
import { PHOTO_UPLOAD_WINDOW_MS } from "@partally/shared";
import { expect, type Page, test } from "@playwright/test";
import {
  type AdminApi,
  adminApi,
  choosePhoto,
  issueToken,
  jpeg,
  LOCAL_ONLY,
  participant,
  REMOTE_URL,
  updateSettings,
  useDefaultSettings,
} from "./helpers";

/**
 * P1: 主要な連携（docs/e2e-tests.md の 3 章）。
 * 準備のデータは API で作り、確かめたい流れだけを画面から操作する
 */
useDefaultSettings();

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
    await choosePhoto(page);
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

test.describe("写真のアップロードの上限", () => {
  let moderation: string | undefined;
  /** この節で作った参加者（後で確認待ちの写真を片付ける） */
  const users: string[] = [];
  test.beforeAll(async () => {
    moderation = (await admin.get("/admin/settings")).settings.moderation;
    // 上限まで確認待ちを埋めるので、投稿を検閲待ちにする
    await updateSettings(admin, { moderation: "pre" });
  });
  test.afterAll(async () => {
    // 確認待ちを残すと、API を使い回したときにほかのテスト（確認待ちが 0 になるのを待つもの）が通らないので、却下して片付ける
    for (;;) {
      const { photos } = await admin.get("/admin/photos?status=pending");
      const left = photos.filter((p: { uploaderId: string }) => users.includes(p.uploaderId));
      if (left.length === 0) break;
      for (const p of left) await admin.post(`/admin/photos/${p.photoId}/reject`);
    }
    if (moderation) await updateSettings(admin, { moderation });
  });

  /**
   * 確認待ちの写真を n 枚、画面を通さずに置く（ローカルの S3 の代わり /__dev/upload は署名を確かめないので、
   * 枠を取らずに置ける。区切りの上限に数えないため）
   */
  async function fillPending(page: Page, userId: string, n: number): Promise<string[]> {
    const body = await jpeg(page);
    const photoIds: string[] = [];
    for (let i = 0; i < n; i++) {
      const photoId = `e2e${Date.now()}${i}`;
      photoIds.push(photoId);
      for (const kind of ["thumb", "full"]) {
        const res = await page.request.post("/__dev/upload", {
          multipart: {
            key: `uploads/${photoId}/${kind}.jpg`,
            "x-amz-meta-uploader": userId,
            file: { name: `${kind}.jpg`, mimeType: "image/jpeg", buffer: body },
          },
        });
        expect(res.ok()).toBe(true);
      }
    }
    return photoIds;
  }

  const uploadCount = async (page: Page) => (await (await page.request.get("/api/me")).json()).user.uploadCount;
  /**
   * 送り直しの時計を進め、送り先の発行の応答を待つ。前の送信を終えて次の送り直しの時計を掛けてから進めるよう、
   * 「今すぐ再送」が出る（送信が終わり、案内を出した）まで待つ
   */
  async function retryAfterWaiting(page: Page) {
    await expect(page.getByRole("button", { name: "今すぐ再送" })).toBeVisible();
    const response = page.waitForResponse("**/api/photos/upload-url");
    await page.clock.fastForward(60_000);
    return (await response).status();
  }

  test("P1 確認待ちが上限に達すると写真は残って案内が出て、幹事が確認すると自動で送られる", async ({ browser }) => {
    // 確認待ちを埋めるのに、ローカルの S3 の代わり /__dev/upload を使う
    test.skip(!!REMOTE_URL, LOCAL_ONLY);
    const a = await participant(browser, admin, "上限 確認待ち");
    users.push(a.user.userId);
    const { page } = a;
    const filled = await fillPending(page, a.user.userId, 30);
    expect(await uploadCount(page)).toBe(30);

    // 送り直しの間隔（60 秒）を待たずに確かめるため、画面の時計を差し替える
    await page.clock.install();
    await page.goto("/");
    await choosePhoto(page);
    await expect(page.getByText("確認待ちの写真が多いため、幹事が確認するまで送信を待っています")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("送信待ち：1 枚")).toBeVisible();

    // 自動で送り直しても断られる間は、送信の失敗に数えない（5 回を超えても捨てない）
    for (let i = 0; i < 6; i++) expect(await retryAfterWaiting(page)).toBe(429);
    await expect(page.getByText("送信待ち：1 枚")).toBeVisible();
    await expect(page.getByText(/送信できなかった写真/)).toHaveCount(0);
    expect(await uploadCount(page)).toBe(30);

    // 幹事が 1 枚承認すると、次の送り直しで送られる
    await admin.post(`/admin/photos/${filled[0]}/approve`);
    expect(await retryAfterWaiting(page)).toBe(200);
    await expect.poll(() => uploadCount(page), { timeout: 20_000 }).toBe(31);
    await expect(page.getByText(/送信待ち|送信中/)).toHaveCount(0);
    await expect(page.getByText("確認待ちの写真が多いため")).toHaveCount(0);
  });

  test("P1 短い間に送りすぎると写真は残って案内が出る", async ({ browser }) => {
    // 区切り（10 分。時刻で区切る）が途中で変わると枠が空くので、区切りの終わりが近ければ次の区切りまで待つ
    const left = PHOTO_UPLOAD_WINDOW_MS - (Date.now() % PHOTO_UPLOAD_WINDOW_MS);
    if (left < 30_000) {
      test.setTimeout(60_000 + left);
      await new Promise((resolve) => setTimeout(resolve, left + 1_000));
    }
    const a = await participant(browser, admin, "上限 回数");
    users.push(a.user.userId);
    const { page } = a;
    // 区切り（10 分）の枠を使い切る（写真は送らない）
    for (let i = 0; i < 30; i++) {
      const res = await page.request.post("/api/photos/upload-url", { data: {} });
      expect(res.ok()).toBe(true);
    }

    await page.clock.install();
    await page.goto("/");
    await choosePhoto(page);
    await expect(page.getByText("短い間にたくさん送ったため、少し待ってから自動的に送ります")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("送信待ち：1 枚")).toBeVisible();
    for (let i = 0; i < 6; i++) expect(await retryAfterWaiting(page)).toBe(429);
    await expect(page.getByText("送信待ち：1 枚")).toBeVisible();
    await expect(page.getByText(/送信できなかった写真/)).toHaveCount(0);
    expect(await uploadCount(page)).toBe(0);
  });
});

test.describe("HEIC の写真", () => {
  /** ffmpeg から作った HEIC（320×240。e2e/fixtures/make-heic.py） */
  const heic = () => readFileSync(new URL("../fixtures/sample.heic", import.meta.url));

  test("P1 HEIC の写真を選ぶと、JPEG に変換されて送られ、ギャラリーに出る", async ({ browser }) => {
    const a = await participant(browser, admin, "HEIC 投稿");
    const { page } = a;
    await page.goto("/");
    // HEIC を読めない Chromium では、heic2any で JPEG に変換してから縮小して送る
    await choosePhoto(page, { name: "IMG_0001.HEIC", mimeType: "image/heic", buffer: heic() });
    await expect
      .poll(async () => (await (await page.request.get("/api/me")).json()).user.uploadCount, { timeout: 30_000 })
      .toBe(1);
    await expect(page.locator(".error")).toHaveCount(0);

    // ギャラリーで元の大きさのまま表示されることを確かめる（変換に失敗すると取り込まれない）。
    // 公開の方法はほかのテストの設定のままなので、確認待ちなら承認する
    const [photo] = (await (await page.request.get("/api/photos/mine")).json()).photos;
    expect(["pending", "approved"]).toContain(photo.status);
    if (photo.status === "pending") await admin.post(`/admin/photos/${photo.photoId}/approve`);
    await page.goto("/gallery");
    const image = page.locator(`main img[src*="${photo.photoId}"]`);
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((e) => [(e as HTMLImageElement).naturalWidth, (e as HTMLImageElement).naturalHeight]))
      .toEqual([320, 240]);
    await a.context.close();
  });

  test("P1 読めない HEIC は送らずに案内が出る", async ({ browser }) => {
    const a = await participant(browser, admin, "HEIC 破損");
    const { page } = a;
    const requested: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/photos/upload-url")) requested.push(r.url());
    });
    await page.goto("/");
    await choosePhoto(page, { name: "IMG_0002.HEIC", mimeType: "image/heic", buffer: Buffer.from("not a heic file") });
    await expect(page.getByText("この写真は読み込めませんでした。別の写真でお試しください。")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/送信待ち|送信中/)).toHaveCount(0);
    expect(requested).toEqual([]);
    expect((await (await page.request.get("/api/me")).json()).user.uploadCount).toBe(0);
    await a.context.close();
  });
});
