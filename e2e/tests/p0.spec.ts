import { expect, test } from "@playwright/test";
import {
  type AdminApi,
  acceptConfirm,
  adminApi,
  adminPage,
  deleteScheduleItems,
  homePoints,
  issueToken,
  jpeg,
  PHONE,
  participant,
  todayAt,
  unique,
  updateSettings,
  useDefaultSettings,
} from "./helpers";

/**
 * P0: イベント当日に壊れると進行が止まる流れ（docs/e2e-tests.md の 2 章）。
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

/** 開催中のゲーム・ラウンドを残さない（ほかのテストが開始できるように） */
test.afterEach(async () => {
  for (const r of (await admin.get("/admin/rounds")).rounds) {
    if (r.status === "open") await admin.post(`/admin/rounds/${r.roundId}/stop`);
  }
  for (const g of (await admin.get("/admin/games")).games) {
    if (g.status === "open" && !g.roundId) await admin.post(`/admin/games/${g.gameId}/stop`);
  }
});

test("P0-1 QR から名前と暗証番号で登録すると、二つ名が授けられホームに出る", async ({ browser }) => {
  const token = await issueToken(admin);
  const page = await (await browser.newContext({ viewport: PHONE, locale: "ja-JP" })).newPage();
  await page.goto(`/q/${token}`);
  await page.getByLabel("お名前").fill("登録 太郎");
  await page.getByLabel(/暗証番号（数字/).fill("2468");
  await page.getByLabel("暗証番号（確認のため、もう一度）").fill("2468");
  await page.getByRole("button", { name: "登録する" }).click();
  const epithet = page.locator(".reveal .epithet");
  await expect(epithet).toHaveText(/〈.+〉/);
  const title = (await epithet.textContent()) ?? "";
  await page.getByRole("link", { name: "はじめる" }).click();
  await expect(page.locator(".profile .epithet")).toHaveText(title);
  await expect(page.locator(".profile .name")).toHaveText("登録 太郎");
  await expect(page.locator(".points-value")).toHaveText("0");
});

test("P0-2 同じ端末でもう一度 QR を読み込むと、暗証番号を聞かれずにホームへ入れる", async ({ browser }) => {
  const a = await participant(browser, admin, "再訪 花子");
  await a.page.goto(`/q/${a.token}`);
  await expect(a.page).toHaveURL(/\/$/);
  await expect(a.page.locator(".profile .name")).toHaveText("再訪 花子");
});

test("P0-3 別の端末では暗証番号でログインでき、間違えると残りの回数が出る", async ({ browser }) => {
  const a = await participant(browser, admin, "別端末 次郎", "1357");
  const other = await (await browser.newContext({ viewport: PHONE, locale: "ja-JP" })).newPage();
  await other.goto(`/q/${a.token}`);
  await expect(other.getByRole("heading", { name: "暗証番号を入れてください" })).toBeVisible();
  await other.getByLabel(/暗証番号（数字/).fill("0000");
  await other.getByRole("button", { name: "ログイン" }).click();
  await expect(other.locator(".error")).toContainText(/暗証番号が違います.*\d/);
  await other.getByLabel(/暗証番号（数字/).fill("1357");
  await other.getByRole("button", { name: "ログイン" }).click();
  await expect(other).toHaveURL(/\/$/);
  await expect(other.locator(".profile .name")).toHaveText("別端末 次郎");
});

test("P0-4 幹事がログインして QR を発行し、通し番号付きで印刷ページに並ぶ", async ({ browser }) => {
  const { page, context } = await adminPage(browser);
  await page.goto("/admin/tokens");
  const before = (await admin.get("/admin/tokens")).tokens.length;
  await page.getByLabel("発行数").fill("3");
  await page.getByRole("button", { name: "発行", exact: true }).click();
  await acceptConfirm(page);
  await expect.poll(async () => (await admin.get("/admin/tokens")).tokens.length).toBe(before + 3);
  const print = await context.newPage();
  await print.goto("/admin/tokens/print?filter=unbound");
  const labels = await admin.get("/admin/tokens");
  const last = labels.tokens.at(-1).label;
  await expect(print.locator(".qr-label", { hasText: `No. ${last}` })).toBeVisible();
  await expect(print.locator(".qr-card img.qr").first()).toBeVisible();
});

test("P0-5 写真を投稿して幹事が承認すると、ほかの参加者に見え、投稿者にポイントが入る", async ({ browser }) => {
  await updateSettings(admin, { moderation: "pre" });
  const a = await participant(browser, admin, unique("写真 一郎"));
  const b = await participant(browser, admin, "閲覧 二郎");
  const before = (await (await a.page.request.get("/api/me")).json()).user.points;

  await a.page.goto("/");
  const chooser = a.page.waitForEvent("filechooser");
  await a.page.getByRole("button", { name: "写真を選ぶ" }).click();
  await (await chooser).setFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: await jpeg(a.page) });
  // 送り終わる前に画面を読み込み直すと、送り直しの待ちに入るので、届くまで待つ
  await expect
    .poll(async () => (await (await a.page.request.get("/api/me")).json()).user.uploadCount, { timeout: 20_000 })
    .toBe(1);
  await a.page.getByRole("link", { name: "自分の写真" }).click();
  await expect(a.page.getByText("確認待ち").first()).toBeVisible({ timeout: 20_000 });

  const { page: adm } = await adminPage(browser);
  await adm.goto("/admin/photos");
  // ほかの人の確認待ちの写真もあり得るので、この参加者の写真を承認する
  await adm.locator(".admin-photo", { hasText: a.user.name }).getByRole("button", { name: "承認" }).click();
  const myPhoto = async () => (await (await a.page.request.get("/api/photos/mine")).json()).photos[0];
  await expect.poll(async () => (await myPhoto())?.status).toBe("approved");

  // ほかの人の写真もギャラリーに並ぶので、この参加者の写真が見えることを確かめる
  await b.page.goto("/gallery");
  await expect(b.page.locator(`main img[src*="${(await myPhoto()).photoId}"]`)).toBeVisible();
  await expect.poll(async () => homePoints(a.page)).toBeGreaterThan(before);
});

test("P0-6 クイズを開始すると参加者にお知らせが出て、決定で答え、終了でポイントが入る", async ({ browser }) => {
  const a = await participant(browser, admin, "クイズ 三郎");
  const { game } = await admin.post("/admin/games", {
    format: "quiz",
    name: unique("幹事の出身地は？"),
    choices: [
      { text: "北海道", points: 10 },
      { text: "沖縄", points: 0 },
    ],
  });
  // 名前は保存するときに NFKC でそろう（「？」は「?」になる）ので、保存された名前で探す
  const quizName: string = game.name;
  await a.page.goto("/");
  const { page: adm } = await adminPage(browser);
  await adm.goto("/admin/games");
  const card = adm.locator("article.game-card", { hasText: quizName });
  await card.locator("header").getByRole("button", { name: "開始" }).click();

  // 参加者の画面は 5 秒ごとに確かめるので、読み込み直さなくてもお知らせが出る
  const banner = a.page.locator(".quiz-banner");
  await expect(banner).toContainText(quizName, { timeout: 15_000 });
  await banner.click();
  await a.page.getByRole("button", { name: "北海道", exact: true }).click();
  await a.page.getByRole("button", { name: "決定" }).click();
  await expect(a.page.locator(".game-done-stamp")).toBeVisible();
  await expect(a.page.getByRole("button", { name: "沖縄", exact: true })).toBeDisabled();

  await card.locator("header").getByRole("button", { name: "終了" }).click();
  await acceptConfirm(adm);
  await expect
    .poll(
      async () =>
        (await admin.get("/admin/games")).games.find((g: { gameId: string }) => g.gameId === game.gameId).status,
    )
    .toBe("confirmed");
  await a.page.goto("/");
  await expect(a.page.locator(".points-value")).toHaveText("10");
});

test("P0-7 結果入力のゲームを管理画面で作って人を選び、開始・終了すると、選んだ人のホームに「優勝 +30」が出る", async ({
  browser,
}) => {
  const a = await participant(browser, admin, unique("優勝 四郎"));
  const gameName = unique("じゃんけん大会");
  const { page: adm } = await adminPage(browser);
  await adm.goto("/admin/games");

  // 結果入力を選び、名前と枠（優勝 30 点）を入れて作る
  await adm.getByRole("button", { name: "ゲームを作る" }).click();
  const form = adm.locator("dialog.game-dialog[open]");
  // 形式は、ラジオボタンを覆うパネルを押して選ぶ
  await form.locator("label.game-format-panel", { hasText: "結果入力" }).click();
  await expect(form.getByRole("radio", { name: /結果入力/ })).toBeChecked();
  await form.getByLabel("名前", { exact: true }).fill(gameName);
  await form.getByRole("button", { name: "枠を追加" }).click();
  await form.getByRole("textbox", { name: /^枠 1/ }).fill("優勝");
  // 名前はラベルの「点数」と、範囲の案内（0〜100）をつなげたもの
  await form.getByRole("textbox", { name: /^点数/ }).fill("30");
  await form.getByRole("button", { name: "保存" }).click();
  await expect(form).toHaveCount(0);

  // 枠の「人を選ぶ」で、名前で絞り込んで選ぶ
  const card = adm.locator("article.game-card", { hasText: gameName });
  await card.getByRole("button", { name: "優勝の人を選ぶ", exact: true }).click();
  const picker = adm.locator("dialog.game-dialog[open]");
  await picker.getByRole("searchbox", { name: "絞り込み" }).fill(a.user.name);
  await picker.getByRole("checkbox").check();
  await picker.getByRole("button", { name: "保存" }).click();
  await expect(picker).toHaveCount(0);
  await expect(card.locator(".game-slot-members")).toContainText(a.user.name);

  await card.locator("header").getByRole("button", { name: "開始" }).click();
  await expect(card.locator("header").getByRole("button", { name: "終了" })).toBeVisible();
  // 結果入力のお知らせは「ゲーム開催中」
  await a.page.goto("/");
  await expect(a.page.locator(".quiz-banner")).toContainText("ゲーム開催中");
  await card.locator("header").getByRole("button", { name: "終了" }).click();
  await acceptConfirm(adm);
  await expect(card.locator(".status")).toHaveText("終了");
  await a.page.goto("/");
  await expect(a.page.locator(".game-awards")).toContainText(gameName);
  await expect(a.page.locator(".game-awards")).toContainText("優勝");
  await expect(a.page.locator(".game-awards")).toContainText("+30");
});

test("P0-8 お気に入りを付けると双方のポイントが増え、外すと戻る", async ({ browser }) => {
  await updateSettings(admin, { moderation: "post", favoritesEnabled: true });
  const a = await participant(browser, admin, "被写体 五郎");
  const b = await participant(browser, admin, "応援 六郎");
  const me = async (p: typeof a) => (await (await p.page.request.get("/api/me")).json()).user;
  await a.page.goto("/");
  const chooser = a.page.waitForEvent("filechooser");
  await a.page.getByRole("button", { name: "写真を選ぶ" }).click();
  await (await chooser).setFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: await jpeg(a.page, "#2980b9") });
  await expect.poll(async () => (await me(a)).approvedCount, { timeout: 20_000 }).toBe(1);

  const [aBefore, bBefore] = [(await me(a)).points, (await me(b)).points];
  // ほかの人の写真もギャラリーに並ぶので、a の写真のタイルで押す
  const [photo] = (await (await a.page.request.get("/api/photos/mine")).json()).photos;
  await b.page.goto("/gallery");
  const tile = b.page.locator(".photo-tile", { has: b.page.locator(`img[src*="${photo.photoId}"]`) });
  await tile.getByRole("button", { name: "お気に入りに選ぶ" }).click();
  await expect(tile.getByRole("button", { name: "お気に入りを外す" })).toBeVisible();
  await expect.poll(async () => (await me(a)).points).toBeGreaterThan(aBefore);
  await expect.poll(async () => (await me(b)).points).toBeGreaterThan(bBefore);

  await tile.getByRole("button", { name: "お気に入りを外す" }).click();
  await expect.poll(async () => (await me(a)).points).toBe(aBefore);
  await expect.poll(async () => (await me(b)).points).toBe(bBefore);
});

test("P0-9 ランキングを公開すると参加者に出て、幹事の推移の再生の最後が今の並びになる", async ({ browser }) => {
  const a = await participant(browser, admin, unique("首位 七郎"));
  await admin
    .post("/admin/games", {
      format: "result",
      name: "ランキング用",
      slots: [{ name: "優勝", points: 50, userIds: [a.user.userId] }],
    })
    .then(async ({ game }) => {
      await admin.post(`/admin/games/${game.gameId}/open`);
      await admin.post(`/admin/games/${game.gameId}/confirm`);
    });
  await updateSettings(admin, { rankingVisible: true, rankingHideNames: false, rankingHidePoints: false });
  const { ranking } = await admin.get("/admin/ranking");

  await a.page.goto("/standings");
  await expect(a.page.locator(".ranking-table")).toContainText(a.user.name);

  const { page: adm } = await adminPage(browser);
  await adm.goto("/admin/ranking");
  await adm.getByRole("button", { name: "▶ 推移を再生" }).click();
  // 再生は約 20 秒。終わると「表に戻る」が出て、今のランキングの 1 位が 1 位に並ぶ
  await expect(adm.getByRole("button", { name: "表に戻る" })).toBeVisible({ timeout: 40_000 });
  // 同じ名前の人がいても 1 人に決まるよう、二つ名付きの表示名（二つ名は全員で重ならない）で探す
  const top = adm.locator(".race-row").filter({ has: adm.getByTitle(ranking[0].displayName, { exact: true }) });
  await expect(top.locator(".race-rank")).toHaveText("1");
  await adm.getByRole("button", { name: "表に戻る" }).click();
  await expect(adm.locator(".ranking-table")).toContainText(ranking[0].name);
});

test("P0-10 画像付きの景品を順位に割り当てて公開すると、参加者の画面とランキングの行に出る", async ({ browser }) => {
  const a = await participant(browser, admin, "景品 八郎");
  const prizeName = unique("E2E のテレビ");
  const { page: adm } = await adminPage(browser);
  await adm.goto("/admin/prizes");
  await adm.getByRole("button", { name: "景品を登録" }).click();
  const dialog = adm.locator("dialog[open]");
  await dialog.getByLabel("名前").fill(prizeName);
  await dialog.getByRole("textbox", { name: /^数量/ }).fill("8");
  await dialog.getByPlaceholder("例: 1, 3, 5-10").fill("1, 3, 5-10");
  await dialog
    .locator("input[type=file]")
    .setInputFiles({ name: "prize.jpg", mimeType: "image/jpeg", buffer: await jpeg(adm, "#27ae60") });
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });
  await expect(adm.locator("main")).toContainText(prizeName);

  await updateSettings(admin, { prizesVisible: true, rankingVisible: true });
  await a.page.goto("/standings");
  await a.page.getByRole("tab", { name: "景品" }).click();
  const item = a.page.locator(".prize-list-item", { hasText: prizeName });
  await expect(item).toBeVisible();
  await expect(item.locator("img")).toBeVisible();
  await a.page.getByRole("tab", { name: "ランキング" }).click();
  await expect(a.page.locator(".ranking-table")).toContainText(prizeName);
});

test("P0-11 タイムラインで作った項目を公開すると、今の項目に「いま」、次の項目に「つぎ」が付き、押すと詳細が出る", async ({
  browser,
}) => {
  const a = await participant(browser, admin, "予定 九郎");
  const title = unique("E2E の乾杯");
  const nextTitle = unique("E2E の歓談");
  // 参加者の時刻は 12:00 にする（流した時刻で「いま」「つぎ」が変わらないように）
  await a.page.clock.setFixedTime(todayAt(12 * 60));
  const { page: adm } = await adminPage(browser);
  try {
    // 管理画面のタイムラインの「項目を追加」で、11:50 から 1 時間の項目を作る
    await adm.goto("/admin/schedule");
    await adm.getByRole("button", { name: "項目を追加", exact: true }).click();
    const dialog = adm.locator("dialog[open]");
    await dialog.getByLabel("タイトル", { exact: true }).fill(title);
    await dialog.getByLabel("開始", { exact: true }).fill("11:50");
    await dialog.getByRole("button", { name: "1 時間", exact: true }).click();
    await dialog.getByLabel("詳細（任意）").fill("幹事の挨拶のあと、全員で乾杯します。");
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(adm.locator(".schedule-grid .schedule-block", { hasText: title })).toHaveAccessibleName(
      new RegExp(`^11:50〜12:50 ${title}`),
    );
    // 次の項目（12:01 から）は準備として API で作る。12:01 に始まる項目はほかにあっても同じく「つぎ」なので、
    // データの入った環境でもこの項目に「つぎ」が付く
    await admin.post("/admin/schedule", {
      title: nextTitle,
      detail: "",
      startMinute: 12 * 60 + 1,
      durationMinutes: 30,
    });
    await updateSettings(admin, { scheduleVisible: true, scheduleDate: "" });

    // 参加者に見せるのはスケジュールだけ（設定はほかを既定値の「見せない」にそろえている）なので、切り替えのタブは出ない
    await a.page.goto("/standings");
    await expect(a.page.getByRole("tablist")).toHaveCount(0);
    const block = a.page.locator(".schedule-block", { hasText: title });
    await expect(block.locator(".schedule-badge")).toHaveText("いま");
    await expect(a.page.locator(".schedule-block", { hasText: nextTitle }).locator(".schedule-badge")).toHaveText(
      "つぎ",
    );
    await block.click();
    await expect(a.page.locator("dialog[open]")).toContainText("幹事の挨拶のあと、全員で乾杯します。");
  } finally {
    // 同じ時刻に流すたびに列が増えないよう、作った項目を消す
    await deleteScheduleItems(admin, [title, nextTitle]);
  }
});

test("P0-12 イベントを終了すると参加者に知らせ、終了後の点数は数えず、取り消すと数える", async ({ browser }) => {
  // 終了済みの環境で流すと、最後の取り消しで、その環境の終了まで消してしまう
  const { endedAt } = await admin.get("/admin/event");
  test.skip(!!endedAt, "イベントが既に終了している環境では、終了の記録を消さないよう流さない");
  const a = await participant(browser, admin, "終了 十郎");
  const finish = async (name: string, points: number) => {
    const { game } = await admin.post("/admin/games", {
      format: "result",
      name,
      slots: [{ name: "優勝", points, userIds: [a.user.userId] }],
    });
    await admin.post(`/admin/games/${game.gameId}/open`);
    await admin.post(`/admin/games/${game.gameId}/confirm`);
  };
  await finish("終了前の大会", 20);
  const { page: adm } = await adminPage(browser);
  try {
    await adm.goto("/admin/settings");
    await adm.getByRole("button", { name: "イベントを終了する" }).click();
    await acceptConfirm(adm);
    await expect(adm.getByRole("button", { name: "終了を取り消す" })).toBeVisible();

    await a.page.goto("/");
    await expect(a.page.locator(".event-ended")).toContainText("イベントは終了しました");
    await finish("終了後の大会", 30);
    await a.page.goto("/");
    await expect(a.page.locator(".points-value")).toHaveText("20");

    await adm.getByRole("button", { name: "終了を取り消す" }).click();
    await acceptConfirm(adm);
    await a.page.goto("/");
    await expect(a.page.locator(".event-ended")).toHaveCount(0);
    await expect(a.page.locator(".points-value")).toHaveText("50");
  } finally {
    // ほかのテストのために、終了したままにしない
    await admin.post("/admin/event/reopen");
  }
});
