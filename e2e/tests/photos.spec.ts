import { expect, type Page, test } from "@playwright/test";
import {
  type AdminApi,
  acceptConfirm,
  adminApi,
  adminPage,
  choosePhoto,
  issueToken,
  jpeg,
  myPhotos,
  PREVIEW_URL,
  participant,
  postPhoto,
  updateSettings,
  useDefaultSettings,
} from "./helpers";

/**
 * 写真・お気に入り（docs/e2e-tests.md の 3 章「写真・お気に入り」と 4 章の P2、#268）。
 * 準備の写真は postPhoto() で API から送り、確かめたい流れだけを画面から操作する
 */
useDefaultSettings();

let admin: AdminApi;
test.beforeAll(async () => {
  admin = await adminApi();
});
test.afterAll(async () => {
  await admin.dispose();
});

type Me = {
  points: number;
  uploadCount: number;
  approvedCount: number;
  favoritesGiven: number;
  favoritesReceived: number;
};
const me = async (page: Page): Promise<Me> => (await (await page.request.get("/api/me")).json()).user;

/** 画面を通さずに、お気に入りを付ける（PUT）・外す（DELETE） */
const favorite = (page: Page, photoId: string, method: "PUT" | "DELETE" = "PUT") =>
  page.request.fetch(`/api/photos/${photoId}/favorite`, { method, data: {} });

/** みんなの写真の、その写真のタイル */
const galleryTile = (page: Page, photoId: string) =>
  page.locator("main .photo-tile", { has: page.locator(`img[src*="${photoId}"]`) });
/** みんなの写真を開き、一覧を読み込み終えるまで待つ（見出しは一覧より先に出るので、写真が無いことを確かめる前に待つ） */
async function openGallery(page: Page) {
  const loaded = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/photos" && r.ok());
  await page.goto("/gallery");
  await loaded;
  // 応答を受けた後の描画まで待つ（写真が 1 枚も無ければ、その案内が出る）
  const tiles = page.locator("main .photo-grid .photo-tile");
  await expect(tiles.or(page.getByText("まだ写真がありません。")).first()).toBeVisible();
}
/** 幹事の写真の画面の、その写真のカード */
const adminCard = (page: Page, photoId: string) =>
  page.locator(".admin-photo", { has: page.locator(`img[src*="${photoId}"]`) });

/** JPEG の中に、撮影情報（EXIF）の APP1 があるか */
const hasExif = (data: Buffer) => data.includes(Buffer.from("Exif\0\0", "latin1"));

/**
 * JPEG に、位置情報（GPS の緯度）を入れた EXIF を足す。スマホで撮った写真の代わり。
 * TIFF（リトルエンディアン）の IFD0 に GPS の IFD への場所だけを置き、GPS の IFD に緯度の向きと緯度を置く
 */
function withGpsExif(jpegData: Buffer): Buffer {
  const tiff = Buffer.alloc(80);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 の場所
  // IFD0：GPSInfo（0x8825）だけ
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8825, 10);
  tiff.writeUInt16LE(4, 12); // LONG
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(26, 18); // GPS の IFD の場所
  tiff.writeUInt32LE(0, 22); // 次の IFD なし
  // GPS の IFD：GPSLatitudeRef（"N"）と GPSLatitude（35/1, 41/1, 0/1）
  tiff.writeUInt16LE(2, 26);
  tiff.writeUInt16LE(0x0001, 28);
  tiff.writeUInt16LE(2, 30); // ASCII
  tiff.writeUInt32LE(2, 32);
  tiff.write("N\0", 36, "latin1");
  tiff.writeUInt16LE(0x0002, 40);
  tiff.writeUInt16LE(5, 42); // RATIONAL
  tiff.writeUInt32LE(3, 44);
  tiff.writeUInt32LE(56, 48); // 値の場所
  tiff.writeUInt32LE(0, 52); // 次の IFD なし
  for (const [i, v] of [35, 1, 41, 1, 0, 1].entries()) tiff.writeUInt32LE(v, 56 + i * 4);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  // SOI（FFD8）の直後に APP1 を入れる
  return Buffer.concat([jpegData.subarray(0, 2), header, payload, jpegData.subarray(2)]);
}

/** 画像の元の大きさ（幅・高さ） */
const naturalSize = (image: ReturnType<Page["locator"]>) =>
  image.evaluate((e) => [(e as HTMLImageElement).naturalWidth, (e as HTMLImageElement).naturalHeight]);

test.describe("写真の投稿と公開", () => {
  test("P1 大きい写真は縮小され、一覧ではサムネイル、拡大では本体が出て、撮影情報は消える", async ({ browser }) => {
    await updateSettings(admin, { moderation: "post" });
    const a = await participant(browser, admin, "縮小 投稿");
    const { page } = a;
    const original = withGpsExif(await jpeg(page, "#8e44ad", { width: 3200, height: 2400 }));
    expect(hasExif(original)).toBe(true);
    await page.goto("/");
    await choosePhoto(page, { name: "IMG_0003.jpg", mimeType: "image/jpeg", buffer: original });
    await expect.poll(async () => (await myPhotos(page)).length, { timeout: 30_000 }).toBe(1);
    const [photo] = await myPhotos(page);

    // 一覧はサムネイル（長辺 400px）
    await page.goto("/gallery");
    const thumb = galleryTile(page, photo!.photoId).locator("img");
    await expect(thumb).toBeVisible();
    await expect.poll(() => naturalSize(thumb)).toEqual([400, 300]);

    // 拡大は本体（長辺 1600px）
    await galleryTile(page, photo!.photoId).locator("button").first().click();
    const full = page.locator("dialog.lightbox img");
    await expect(full).toBeVisible();
    await expect.poll(() => naturalSize(full)).toEqual([1600, 1200]);

    // 配られる画像に、位置情報などの撮影情報が残っていない（画面で JPEG に描き直して送るため）
    for (const src of [await thumb.getAttribute("src"), await full.getAttribute("src")]) {
      const res = await page.request.get(src!);
      expect(res.ok()).toBe(true);
      expect(hasExif(await res.body())).toBe(false);
    }
  });

  test("P1 オフラインで投稿すると送信待ちがホームに出て、オンラインに戻ると自動で送られる", async ({ browser }) => {
    // 開発用のサーバの画面は、オフラインにすると接続が切れたのを見て開き直す（オフラインなので開けなくなる）ので、
    // 本番と同じビルドの画面で確かめる
    const a = await participant(browser, admin, "オフライン 投稿", "1234", { baseURL: PREVIEW_URL });
    const { page, context } = a;
    const uploadCount = async () =>
      (await admin.get("/admin/users")).users.find((u: { userId: string }) => u.userId === a.user.userId).uploadCount;
    // 画面は、開いたとき（参加者の画面の枠）と、ホームを開いたときの 2 回、自分の情報を読む。ホームの読み直しの
    // 途中でオフラインにすると通信エラーになり、画面全体がエラーの表示に変わるので、2 回とも読み終わってから
    // オフラインにする
    let meLoaded = 0;
    page.on("requestfinished", (r) => {
      if (new URL(r.url()).pathname === "/api/me") meLoaded++;
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "写真を選ぶ" })).toBeVisible();
    await expect.poll(() => meLoaded).toBeGreaterThanOrEqual(2);
    await context.setOffline(true);
    await choosePhoto(page);
    await expect(page.getByText("送信待ち：1 枚")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("送信に失敗しました。自動的に再送します。")).toBeVisible();

    // オフラインのまま「今すぐ再送」を押しても、写真は捨てずに送信待ちに残る（通信のエラーは失敗に数えない）
    await page.getByRole("button", { name: "今すぐ再送" }).click();
    await expect(page.getByRole("button", { name: "今すぐ再送" })).toBeVisible();
    await expect(page.getByText("送信待ち：1 枚")).toBeVisible();
    expect(await uploadCount()).toBe(0);

    // オンラインに戻ると、待たずに送られる（「今すぐ再送」で送れることは p1.spec.ts で確かめる）
    await context.setOffline(false);
    await expect.poll(uploadCount, { timeout: 20_000 }).toBe(1);
    await expect(page.getByText(/送信待ち|送信中/)).toHaveCount(0);
    await expect(page.getByText("送信に失敗しました")).toHaveCount(0);
  });

  test("P1 即時公開では承認なしで公開されポイントが入り、公開の方法の切り替えは後の投稿にだけ効く", async ({
    browser,
  }) => {
    const a = await participant(browser, admin, "即時 投稿");
    const { page } = a;
    // 承認してから公開（既定）のときに送った写真は、確認待ち
    await page.goto("/mine");
    await choosePhoto(page);
    await expect.poll(async () => (await myPhotos(page)).length, { timeout: 30_000 }).toBe(1);
    const [first] = await myPhotos(page);
    expect(first!.status).toBe("pending");
    const before = (await me(page)).points;

    // 即時公開に切り替えると、後に送った写真は承認なしで公開されポイントが入る。前の写真は確認待ちのまま
    await updateSettings(admin, { moderation: "post" });
    await page.goto("/mine");
    await choosePhoto(page, { name: "photo2.jpg", mimeType: "image/jpeg", buffer: await jpeg(page, "#16a085") });
    await expect.poll(async () => (await myPhotos(page)).length, { timeout: 30_000 }).toBe(2);
    const [second] = await myPhotos(page);
    expect(second!.status).toBe("approved");
    await expect.poll(async () => (await me(page)).points).toBe(before + 1);
    await page.goto("/mine");
    await expect(page.locator(".photo-tile", { has: page.locator(`img[src*="${second!.photoId}"]`) })).toContainText(
      "公開中",
    );
    await expect(page.locator(".photo-tile", { has: page.locator(`img[src*="${first!.photoId}"]`) })).toContainText(
      "確認待ち",
    );

    // ほかの参加者のギャラリーにも、承認なしで出る
    const b = await participant(browser, admin, "即時 閲覧");
    await b.page.goto("/gallery");
    await expect(galleryTile(b.page, second!.photoId)).toBeVisible();
    await expect(galleryTile(b.page, first!.photoId)).toHaveCount(0);

    // 承認してから公開に戻しても、公開中の写真はそのまま
    await updateSettings(admin, { moderation: "pre" });
    expect((await myPhotos(page)).map((p) => p.status)).toEqual(["approved", "pending"]);
  });

  test("P1 確認待ちの写真は、投稿者本人と幹事にだけ見える", async ({ browser }) => {
    const a = await participant(browser, admin, "確認待ち 投稿");
    const b = await participant(browser, admin, "確認待ち 閲覧");
    const photoId = await postPhoto(a.page);

    // 投稿者本人は、自分の写真で画像と「確認待ち」が見える
    await a.page.goto("/mine");
    await expect(a.page.locator(".photo-tile", { has: a.page.locator(`img[src*="${photoId}"]`) })).toContainText(
      "確認待ち",
    );
    // 幹事は、確認待ちの一覧で見える
    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/photos");
    await expect(adminCard(adm, photoId)).toBeVisible();

    // ほかの参加者には、ギャラリーにも API の一覧にも出ない（投稿者のギャラリーにも、公開されるまで出ない）
    for (const page of [b.page, a.page]) {
      await openGallery(page);
      await expect(galleryTile(page, photoId)).toHaveCount(0);
    }
    const listed = (await (await b.page.request.get("/api/photos")).json()).photos;
    expect(listed.some((p: { photoId: string }) => p.photoId === photoId)).toBe(false);
  });

  test("P1 却下すると投稿者に「非公開」と出て、公開中の写真を削除すると自分の写真から消え、お気に入りとポイントが戻る", async ({
    browser,
  }) => {
    const a = await participant(browser, admin, "却下 投稿");
    const b = await participant(browser, admin, "却下 応援");
    const [a0, b0] = [await me(a.page), await me(b.page)];
    const rejected = await postPhoto(a.page, "#7f8c8d");
    const removed = await postPhoto(a.page, "#d35400");

    // 幹事が画面で 1 枚を却下すると、投稿者の自分の写真に「非公開」と出る（画像は出ない）
    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/photos");
    await adminCard(adm, rejected).getByRole("button", { name: "却下" }).click();
    await expect(adminCard(adm, rejected)).toHaveCount(0);
    await a.page.goto("/mine");
    await expect(a.page.locator(".photo-tile .badge-rejected")).toHaveText("非公開");
    await expect(a.page.locator(`img[src*="${rejected}"]`)).toHaveCount(0);

    // もう 1 枚を公開し、お気に入りに選ばれる
    await admin.post(`/admin/photos/${removed}/approve`);
    expect((await favorite(b.page, removed)).ok()).toBe(true);
    await expect.poll(async () => (await me(a.page)).points).toBe(a0.points + 2);
    expect((await me(b.page)).favoritesGiven).toBe(1);
    await a.page.goto("/mine");
    await expect(a.page.locator(".photo-tile", { has: a.page.locator(`img[src*="${removed}"]`) })).toContainText(
      "公開中",
    );

    // 幹事が公開中の写真を削除すると、自分の写真から消え、お気に入りとポイントが戻る
    await adm.getByRole("button", { name: "公開中" }).click();
    await adminCard(adm, removed).getByRole("button", { name: "削除" }).click();
    await acceptConfirm(adm);
    await expect(adminCard(adm, removed)).toHaveCount(0);
    await a.page.goto("/mine");
    await expect(a.page.locator(".photo-tile")).toHaveCount(1);
    await expect(a.page.locator(`img[src*="${removed}"]`)).toHaveCount(0);
    await expect.poll(async () => (await me(a.page)).points).toBe(a0.points);
    const bAfter = await me(b.page);
    expect(bAfter.favoritesGiven).toBe(0);
    expect(bAfter.points).toBe(b0.points);
    await openGallery(b.page);
    await expect(galleryTile(b.page, removed)).toHaveCount(0);
  });

  test("P1 みんなの写真と管理画面の写真で、「もっと見る」で続きが出る", async ({ browser }) => {
    test.setTimeout(240_000);
    await updateSettings(admin, { moderation: "post" });
    // 1 ページは 30 枚。短い間の上限（1 人 10 分に 30 回）に掛からないよう、2 人で 31 枚を送る
    const a = await participant(browser, admin, "続き 一");
    const b = await participant(browser, admin, "続き 二");
    const posted: string[] = [];
    for (let i = 0; i < 31; i++) posted.push(await postPhoto(i < 16 ? a.page : b.page));
    // 新しい順に並ぶので、最初に送った写真は 2 ページ目に入る
    const oldest = posted[0]!;

    await a.page.goto("/gallery");
    const tiles = a.page.locator("main .photo-grid .photo-tile");
    await expect(tiles).toHaveCount(30);
    await expect(galleryTile(a.page, oldest)).toHaveCount(0);
    await a.page.getByRole("button", { name: "もっと見る" }).click();
    await expect(galleryTile(a.page, oldest)).toBeVisible();
    expect(await tiles.count()).toBeGreaterThan(30);

    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/photos");
    await adm.getByRole("button", { name: "公開中" }).click();
    await expect(adm.locator(".admin-photo")).toHaveCount(30);
    await expect(adminCard(adm, oldest)).toHaveCount(0);
    await adm.getByRole("button", { name: "もっと見る" }).click();
    await expect(adminCard(adm, oldest)).toBeVisible();
    expect(await adm.locator(".admin-photo").count()).toBeGreaterThan(30);
  });
});

test.describe("お気に入り", () => {
  test("P1 お気に入りの受付をオフにすると、付けることも外すこともできず、付いた分は残る", async ({ browser }) => {
    await updateSettings(admin, { moderation: "post" });
    const a = await participant(browser, admin, "受付 被写体");
    const b = await participant(browser, admin, "受付 応援");
    const chosen = await postPhoto(a.page);
    const other = await postPhoto(a.page, "#2c3e50");
    expect((await favorite(b.page, chosen)).ok()).toBe(true);
    const [aBefore, bBefore] = [await me(a.page), await me(b.page)];

    await updateSettings(admin, { favoritesEnabled: false });
    await b.page.goto("/gallery");
    await expect(b.page.getByText("お気に入りの受付は終了しました（♥ が選んだ写真）。")).toBeVisible();
    // 選んだ写真は ♥ のまま押せず、選んでいない写真には ♡ が出ない
    const on = galleryTile(b.page, chosen).getByRole("button", { name: "お気に入りの受付は終了しました" });
    await expect(on).toHaveText("♥");
    await expect(on).toBeDisabled();
    await expect(galleryTile(b.page, other).getByRole("button")).toHaveCount(1); // 拡大のボタンだけ
    // ホームの選択数の案内も出ない
    await b.page.goto("/");
    await expect(b.page.locator(".points-value")).toBeVisible();
    await expect(b.page.getByText(/お気に入り：/)).toHaveCount(0);

    // API からも、付けることも外すこともできない
    for (const res of [await favorite(b.page, other), await favorite(b.page, chosen, "DELETE")]) {
      expect(res.status()).toBe(409);
      expect((await res.json()).error).toBe("favorites_disabled");
    }
    // 付いた分（選ばれた数・ポイント）は残る
    const [aAfter, bAfter] = [await me(a.page), await me(b.page)];
    expect([aAfter.favoritesReceived, aAfter.points]).toEqual([aBefore.favoritesReceived, aBefore.points]);
    expect([bAfter.favoritesGiven, bAfter.points]).toEqual([bBefore.favoritesGiven, bBefore.points]);
  });

  test("P1 お気に入りの上限に達すると新しく選べず、自分の写真には ♡ が出ない", async ({ browser }) => {
    await updateSettings(admin, { moderation: "post", favoriteLimit: 1 });
    const a = await participant(browser, admin, "上限 被写体");
    const b = await participant(browser, admin, "上限 応援");
    const first = await postPhoto(a.page);
    const second = await postPhoto(a.page, "#c0392b");

    await b.page.goto("/gallery");
    await expect(b.page.getByText(/0 \/ 1 枚選択中/)).toBeVisible();
    await galleryTile(b.page, first).getByRole("button", { name: "お気に入りに選ぶ" }).click();
    await expect(galleryTile(b.page, first).getByRole("button", { name: "お気に入りを外す" })).toBeVisible();
    await expect(b.page.getByText(/1 \/ 1 枚選択中/)).toBeVisible();
    await expect(
      galleryTile(b.page, second).getByRole("button", { name: "お気に入りは 1 枚まで選べます" }),
    ).toBeDisabled();
    const res = await favorite(b.page, second);
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toBe("favorite_limit");

    // 自分の写真には、一覧にも拡大にも ♡ が出ない
    await a.page.goto("/gallery");
    for (const photoId of [first, second]) {
      await expect(galleryTile(a.page, photoId).getByRole("button")).toHaveCount(1); // 拡大のボタンだけ
    }
    await galleryTile(a.page, first).locator("button").first().click();
    const lightbox = a.page.locator("dialog.lightbox");
    await expect(lightbox.locator("img")).toBeVisible();
    await expect(lightbox.locator("button.favorite")).toHaveCount(0);
  });

  test("P2 お気に入りの上限を下げても選択済みは残り、上限を下回るまで新しく選べない", async ({ browser }) => {
    await updateSettings(admin, { moderation: "post", favoriteLimit: 3 });
    const a = await participant(browser, admin, "下げる 被写体");
    const b = await participant(browser, admin, "下げる 応援");
    const [p1, p2, p3] = [
      await postPhoto(a.page),
      await postPhoto(a.page, "#f39c12"),
      await postPhoto(a.page, "#1abc9c"),
    ];
    for (const photoId of [p1, p2]) expect((await favorite(b.page, photoId)).ok()).toBe(true);

    await updateSettings(admin, { favoriteLimit: 1 });
    await b.page.goto("/gallery");
    await expect(b.page.getByText(/2 \/ 1 枚選択中/)).toBeVisible();
    const remove = (photoId: string) => galleryTile(b.page, photoId).getByRole("button", { name: "お気に入りを外す" });
    const full = galleryTile(b.page, p3).getByRole("button", { name: "お気に入りは 1 枚まで選べます" });
    await expect(remove(p1)).toBeEnabled();
    await expect(remove(p2)).toBeEnabled();
    await expect(full).toBeDisabled();

    // 1 枚外しても、まだ上限（1 枚）を下回らないので選べない
    await remove(p1).click();
    await expect(b.page.getByText(/1 \/ 1 枚選択中/)).toBeVisible();
    await expect(full).toBeDisabled();
    // 上限を下回ると選べる
    await remove(p2).click();
    await expect(b.page.getByText(/0 \/ 1 枚選択中/)).toBeVisible();
    await galleryTile(b.page, p3).getByRole("button", { name: "お気に入りに選ぶ" }).click();
    await expect(galleryTile(b.page, p3).getByRole("button", { name: "お気に入りを外す" })).toBeVisible();
    expect((await me(b.page)).favoritesGiven).toBe(1);
  });
});

test("P2 送信を 5 回断られた写真は捨てて撮り直しを案内し、後ろの写真は詰まらない", async ({ browser }) => {
  // 断らせる写真と送れる写真を分けるため、1 台の端末に 2 人を登録し、それぞれが撮る（送り先の発行に撮った人が付く）
  const sender = await participant(browser, admin, "破棄 送れる");
  const { page } = sender;
  const token = await issueToken(admin);
  const reg = await page.request.post("/api/auth/register", { data: { token, name: "破棄 断られる", pin: "1234" } });
  expect(reg.ok()).toBe(true);
  const refused = (await reg.json()).user as { userId: string };

  let refusals = 0;
  await page.route("**/api/photos/upload-url", async (route) => {
    if (route.request().postDataJSON()?.userId !== refused.userId) return route.continue();
    refusals++;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "internal_error" }),
    });
  });
  // 送り直しの間隔（30 秒）を待たずに確かめるため、画面の時計を差し替える
  await page.clock.install();
  await page.goto("/");
  await expect(page.locator(".profile .name")).toHaveText("破棄 断られる");
  await choosePhoto(page);
  await expect(page.getByText("送信に失敗しました。自動的に再送します。")).toBeVisible({ timeout: 20_000 });
  expect(refusals).toBe(1);

  // 後ろに撮った写真は、前の写真が断られても送られる。切り替えると画面を開き直し、そのときも送り直す（断られる）
  await page.getByRole("group", { name: "参加者の切り替え" }).getByRole("button", { name: "破棄 送れる" }).click();
  await expect(page.locator(".profile .name")).toHaveText("破棄 送れる");
  await choosePhoto(page, { name: "photo2.jpg", mimeType: "image/jpeg", buffer: await jpeg(page, "#2ecc71") });
  await expect.poll(async () => (await myPhotos(page)).length, { timeout: 30_000 }).toBe(1);
  await expect(page.getByText("送信待ち：1 枚")).toBeVisible();

  // 自動の送り直しで断られ続け、5 回目で捨てて撮り直しを案内する（4 回目までは残して送り直す）
  const discarded = page.getByText("送信できなかった写真が 1 枚ありました。もう一度撮影・選択してください。");
  while (refusals < 5) {
    await expect(page.getByRole("button", { name: "今すぐ再送" })).toBeVisible();
    await expect(discarded).toHaveCount(0);
    const before = refusals;
    await page.clock.fastForward(30_000);
    // 時計は実時間でも進むので、早送りの前に送り直しが走ることもある（1 回以上増えればよい）
    await expect.poll(() => refusals).toBeGreaterThan(before);
  }
  await expect(discarded).toBeVisible();
  await expect(page.getByText(/送信待ち|送信中/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "今すぐ再送" })).toHaveCount(0);
  const { users } = await admin.get("/admin/users");
  expect(users.find((u: { userId: string }) => u.userId === refused.userId).uploadCount).toBe(0);
});
