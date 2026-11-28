import type { RankingResponse } from "@partally/shared";
import { expect, type Page, test } from "@playwright/test";
import {
  type AdminApi,
  acceptConfirm,
  adminApi,
  adminPage,
  choosePhoto,
  homePoints,
  jpeg,
  participant,
  unique,
  updateSettings,
  useDefaultSettings,
} from "./helpers";

/**
 * 参加者への公開・ポイントの設定・景品・ゲームの結果・管理画面の Trend（#271）。
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

/** 結果入力のゲームで、その人に点数を入れる（作って開始し、終了する）。保存された名前（NFKC でそろう）を返す */
async function award(userId: string, points: number, name = "E2E の大会"): Promise<string> {
  const { game } = await admin.post("/admin/games", {
    format: "result",
    name: unique(name),
    slots: [{ name: "優勝", points, userIds: [userId] }],
  });
  await admin.post(`/admin/games/${game.gameId}/open`);
  await admin.post(`/admin/games/${game.gameId}/confirm`);
  return game.name;
}

/** ホームから写真を 1 枚送り、公開する（確認待ちなら幹事が承認する） */
async function publishPhoto(page: Page) {
  await page.goto("/");
  await choosePhoto(page);
  const mine = async () => (await (await page.request.get("/api/photos/mine")).json()).photos;
  await expect.poll(async () => (await mine()).length, { timeout: 30_000 }).toBe(1);
  const [photo] = await mine();
  if (photo.status === "pending") await admin.post(`/admin/photos/${photo.photoId}/approve`);
}

/** 参加者のランキングの行（名前で探す） */
const rankingRow = (page: Page, name: string) => page.locator(".ranking-table tbody tr", { hasText: name });
/** 参加者のランキングの、その人の順位 */
async function rankOf(page: Page, name: string): Promise<number> {
  return Number(await rankingRow(page, name).locator("td").first().textContent());
}

/** 管理画面の Setting で、設定を保存する */
async function saveSettings(adm: Page) {
  await adm.getByRole("button", { name: "保存", exact: true }).click();
  await expect(adm.getByRole("status")).toContainText("保存しました。");
}

test.describe("参加者への公開", () => {
  test("P1 ランキング・推移・景品・スケジュール・ゲームの結果の公開を切り替えると、「イベント情報」の出し分けが変わり、見せないものは API からも返らない", async ({
    browser,
  }) => {
    const { page } = await participant(browser, admin, "公開 見る");
    const status = async (path: string) => (await page.request.get(`/api${path}`)).status();
    const gameResults = async () => (await (await page.request.get("/api/game-results")).json()).games;

    // 既定値ではどれも見せないので、「イベント情報」のタブも出ない
    await page.goto("/");
    await expect(page.getByRole("link", { name: "みんなの写真" })).toBeVisible();
    await expect(page.getByRole("link", { name: "イベント情報" })).toHaveCount(0);
    for (const path of ["/ranking", "/trend", "/prizes", "/schedule"]) expect(await status(path), path).toBe(404);
    expect(await gameResults()).toEqual([]);

    // 管理画面の Setting で、ランキングと景品を見せる
    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/settings");
    await adm.getByRole("switch", { name: /^参加者にランキングを見せる/ }).check();
    await adm.getByRole("switch", { name: /^参加者に景品を見せる/ }).check();
    await saveSettings(adm);
    await page.goto("/");
    await page.getByRole("link", { name: "イベント情報" }).click();
    await expect(page.getByRole("tab")).toHaveText(["ランキング", "景品"]);
    await expect(page.locator(".ranking-table")).toBeVisible();
    await page.getByRole("tab", { name: "景品" }).click();
    await expect(page.getByRole("tab", { name: "景品" })).toHaveAttribute("aria-selected", "true");
    expect([await status("/ranking"), await status("/prizes")]).toEqual([200, 200]);
    expect([await status("/trend"), await status("/schedule")]).toEqual([404, 404]);

    // すべて見せると、スケジュール・ランキング・推移・景品・ゲームの結果の順に並ぶ
    await updateSettings(admin, {
      rankingVisible: true,
      trendVisible: true,
      prizesVisible: true,
      scheduleVisible: true,
      gameResultsVisible: true,
    });
    await page.reload();
    await expect(page.getByRole("tab")).toHaveText([
      "スケジュール",
      "ランキング",
      "ポイントの推移",
      "景品",
      "ゲームの結果",
    ]);
    for (const path of ["/ranking", "/trend", "/prizes", "/schedule"]) expect(await status(path), path).toBe(200);
    await page.getByRole("tab", { name: "ポイントの推移" }).click();
    await expect(page.locator(".ranking-chart svg")).toBeVisible();

    // 1 つだけ見せると、切り替えのタブは出さずにその中身を出す
    await updateSettings(admin, {
      rankingVisible: false,
      trendVisible: false,
      prizesVisible: false,
      scheduleVisible: false,
    });
    await page.reload();
    await expect(page.getByRole("heading", { name: "イベント情報" })).toBeVisible();
    await expect(page.getByRole("tablist")).toHaveCount(0);
    await expect(page.locator("ol.game-results").or(page.getByText("まだ終了したゲームはありません。"))).toBeVisible();
    expect(await status("/ranking")).toBe(404);
  });

  test("P1 名前を伏せると全員が「???」になり、ポイントを伏せると数字を出さずに棒と線の形だけを見せる", async ({
    browser,
  }) => {
    const a = await participant(browser, admin, unique("伏せ 見る"));
    await award(a.user.userId, 30);
    await updateSettings(admin, { rankingVisible: true, trendVisible: true });
    const { page } = a;
    // 縦軸（ポイント）の目盛りの数字。横軸（時刻）の目盛りとは、縦の真ん中にそろえる所で見分ける
    const yTicks = page.locator(".ranking-chart svg text.tick[dominant-baseline=middle]");

    // 伏せないときは、名前とポイント、推移の縦軸の数字が出る
    await page.goto("/standings");
    await expect(rankingRow(page, a.user.name)).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "ポイント" })).toBeVisible();
    await page.getByRole("tab", { name: "ポイントの推移" }).click();
    await expect(yTicks.first()).toBeAttached();

    // 名前を伏せる：ランキングも推移も全員「???」。API も名前と ID を返さない
    await updateSettings(admin, { rankingHideNames: true, trendHideNames: true });
    await page.reload();
    await expect(page.locator(".ranking-table")).toBeVisible();
    expect(new Set(await page.locator(".ranking-table .name-cell").allTextContents())).toEqual(new Set(["???"]));
    const ranking = await (await page.request.get("/api/ranking")).json();
    expect(ranking.hideNames).toBe(true);
    expect(JSON.stringify(ranking)).not.toContain(a.user.userId);
    expect(JSON.stringify(ranking)).not.toContain(a.user.name);
    await page.getByRole("tab", { name: "ポイントの推移" }).click();
    await expect(page.locator(".ranking-chart .end-label").first()).toBeAttached();
    expect(new Set(await page.locator(".ranking-chart .end-label text").allTextContents())).toEqual(new Set(["???"]));

    // ポイントを伏せる（名前は出す）：ランキングはポイントの列が無く棒だけ、推移は縦軸の数字が無い
    await updateSettings(admin, {
      rankingHideNames: false,
      trendHideNames: false,
      rankingHidePoints: true,
      trendHidePoints: true,
    });
    await page.reload();
    const row = rankingRow(page, a.user.name);
    await expect(row).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "ポイント" })).toHaveCount(0);
    await expect(row.locator(".ranking-bar")).toBeVisible();
    // 順位・名前・棒の 3 つだけ（ポイントの欄が無い）
    await expect(row.locator("td")).toHaveCount(3);
    expect((await (await page.request.get("/api/ranking")).json()).hidePoints).toBe(true);
    await page.getByRole("tab", { name: "ポイントの推移" }).click();
    await expect(page.locator(".ranking-chart .series-line").first()).toBeAttached();
    await expect(yTicks).toHaveCount(0);
  });

  test("P2 ゲームの結果を公開すると、終了した順に正解・自分の答えと結果・入った人が出て、点数は出ない", async ({
    browser,
  }) => {
    const a = await participant(browser, admin, unique("結果 見る"));
    const { game: quiz } = await admin.post("/admin/games", {
      format: "quiz",
      name: unique("E2E の結果のクイズ"),
      choices: [
        { text: "北海道", points: 10 },
        { text: "沖縄", points: 0 },
      ],
    });
    await admin.post(`/admin/games/${quiz.gameId}/open`);
    const choiceId = quiz.choices.find((c: { text: string }) => c.text === "北海道").choiceId;
    expect((await a.page.request.put(`/api/game/${quiz.gameId}/answer`, { data: { choiceId } })).ok()).toBe(true);
    await admin.post(`/admin/games/${quiz.gameId}/confirm`);
    const result = await award(a.user.userId, 30, "E2E の結果の大会");
    await updateSettings(admin, { gameResultsVisible: true });

    await a.page.goto("/standings");
    const card = (name: string) => a.page.locator(".game-result", { hasText: name });
    // 終了した順（クイズが先）
    await expect(card(result)).toBeVisible();
    const names = await a.page.locator(".game-result h3").allTextContents();
    const at = (name: string) => names.findIndex((n) => n.startsWith(name));
    expect(at(quiz.name)).toBeGreaterThanOrEqual(0);
    expect(at(quiz.name)).toBeLessThan(at(result));

    await expect(card(quiz.name).locator(".game-result-rows")).toHaveText(/^正解北海道あなた北海道\s*◯ 正解$/);
    await expect(card(result).locator(".game-result-rows")).toHaveText("あなた優勝");
    await expect(card(result).locator(".game-result-awards")).toContainText("優勝");
    await expect(card(result).locator(".game-result-awards")).toContainText(a.user.name);
    for (const name of [quiz.name, result]) {
      await expect(card(name)).not.toContainText(/\+\s*\d|\d+\s*点/);
      await expect(card(name)).not.toContainText("ポイントには数えていません");
    }
  });

  test("P2 イベントの終了の後に終了したゲームには、ポイントに数えていないと出る", async ({ browser }) => {
    // 終了済みの環境で流すと、最後の取り消しで、その環境の終了まで消してしまう
    const { endedAt } = await admin.get("/admin/event");
    test.skip(!!endedAt, "イベントが既に終了している環境では、終了の記録を消さないよう流さない");
    const a = await participant(browser, admin, unique("終了後 結果"));
    const before = await award(a.user.userId, 10, "E2E の終了前");
    await updateSettings(admin, { gameResultsVisible: true });
    await admin.post("/admin/event/end");
    try {
      const after = await award(a.user.userId, 10, "E2E の終了後");
      await a.page.goto("/standings");
      const card = (name: string) => a.page.locator(".game-result", { hasText: name });
      await expect(card(after)).toContainText("イベントの終了の後に終了したので、ポイントには数えていません。");
      await expect(card(before)).toBeVisible();
      await expect(card(before)).not.toContainText("ポイントには数えていません");
    } finally {
      // ほかのテストのために、終了したままにしない
      await admin.post("/admin/event/reopen");
    }
  });

  test("P1 開催中のゲームがあるとイベントを終了できない。終了した後だけ、ホームでの順位・景品の発表を切り替えられる", async ({
    browser,
  }) => {
    // 終了済みの環境で流すと、最後の取り消しで、その環境の終了まで消してしまう
    const { endedAt } = await admin.get("/admin/event");
    test.skip(!!endedAt, "イベントが既に終了している環境では、終了の記録を消さないよう流さない");
    const a = await participant(browser, admin, unique("終了後 発表"));
    await award(a.user.userId, 100, "E2E の発表前");
    const { game } = await admin.post("/admin/games", {
      format: "quiz",
      name: unique("E2E の開催中"),
      choices: [
        { text: "A", points: 10 },
        { text: "B", points: 0 },
      ],
    });
    await admin.post(`/admin/games/${game.gameId}/open`);
    const { page: adm } = await adminPage(browser);
    const rankSwitch = adm.getByRole("switch", { name: "参加者のホーム画面に自分の順位を表示する" });
    const prizeSwitch = adm.getByRole("switch", { name: "参加者のホーム画面に自分の順位の景品" });
    let prizeId: string | undefined;
    try {
      await adm.goto("/admin/settings");
      // 終了する前は切り替えられない
      await expect(rankSwitch).toBeDisabled();
      await expect(prizeSwitch).toBeDisabled();

      // 開催中のゲームがあると、終了できず理由が出る
      await adm.getByRole("button", { name: "イベントを終了する" }).click();
      await acceptConfirm(adm);
      await expect(adm.locator(".event-end .error")).toContainText("開催中のゲームがあります");
      expect((await admin.get("/admin/event")).endedAt).toBeUndefined();

      // 中断すると終了でき、切り替えられるようになる
      await admin.post(`/admin/games/${game.gameId}/stop`);
      await adm.getByRole("button", { name: "イベントを終了する" }).click();
      await acceptConfirm(adm);
      await expect(adm.getByRole("button", { name: "終了を取り消す" })).toBeVisible();
      await expect(rankSwitch).toBeEnabled();
      await expect(prizeSwitch).toBeEnabled();

      // 自分の順位（紐づけを解除した人を除いて上から何番目か）に景品を用意する
      const { ranking }: RankingResponse = await admin.get("/admin/ranking");
      const rank = ranking.filter((r) => r.status !== "unbound").findIndex((r) => r.userId === a.user.userId) + 1;
      expect(rank).toBeGreaterThan(0);
      const prizeName = unique("E2E ホームの景品");
      prizeId = (await admin.post("/admin/prizes", { name: prizeName, quantity: 1, positions: [rank] })).prize.prizeId;

      // オフの間はホームに出ない
      await a.page.goto("/");
      await expect(a.page.locator(".event-ended")).toBeVisible();
      await expect(a.page.locator(".home-standing-card")).toHaveCount(0);

      // オンにして保存すると、ホームに順位と景品が出る
      await rankSwitch.check();
      await prizeSwitch.check();
      await saveSettings(adm);
      await a.page.goto("/");
      await expect(a.page.locator(".home-rank-value")).toHaveText(`${rank} 位`);
      await expect(a.page.locator(".home-prizes")).toContainText(prizeName);

      // 終了を取り消すと、オンのままでも出ない
      await adm.getByRole("button", { name: "終了を取り消す" }).click();
      await acceptConfirm(adm);
      await expect(adm.getByRole("button", { name: "イベントを終了する" })).toBeVisible();
      await expect(rankSwitch).toBeDisabled();
      await a.page.goto("/");
      await expect(a.page.locator(".event-ended")).toHaveCount(0);
      await expect(a.page.locator(".home-standing-card")).toHaveCount(0);
    } finally {
      // ほかのテストのために、終了したままにせず、作った景品を消す
      if ((await admin.get("/admin/event")).endedAt) await admin.post("/admin/event/reopen");
      if (prizeId) await admin.del(`/admin/prizes/${prizeId}`);
    }
  });
});

test.describe("ポイントの設定", () => {
  test("P1 ポイントの点数を変えると、全員のポイントが計算し直され、ホーム・ランキング・幹事のユーザ一覧で一致する", async ({
    browser,
  }) => {
    const a = await participant(browser, admin, unique("再計算 写真"));
    await publishPhoto(a.page);
    await expect.poll(() => homePoints(a.page), { timeout: 20_000 }).toBe(1);

    // 管理画面の Setting で、写真 1 枚のポイントを 1 から 5 に変える（これまでの分も変わる）
    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/settings");
    await adm.getByRole("textbox", { name: /^写真 1 枚が公開されたときのポイント/ }).fill("5");
    await saveSettings(adm);

    expect(await homePoints(a.page)).toBe(5);
    await updateSettings(admin, { rankingVisible: true });
    await a.page.goto("/standings");
    await expect(rankingRow(a.page, a.user.name).locator("td.num strong")).toHaveText("5");
    await adm.goto("/admin/users");
    await expect(adm.locator("tbody tr", { hasText: a.user.name }).locator("td.num strong").first()).toHaveText("5");
  });

  test("P1 ポイント・ゲームの点数を伏せると参加者のホームに出なくなり、幹事のユーザ一覧には出る", async ({
    browser,
  }) => {
    const a = await participant(browser, admin, unique("伏せ ホーム"));
    const gameName = await award(a.user.userId, 30);
    const { page } = a;
    const stat = (label: string) => page.locator(".stats div", { has: page.getByText(label, { exact: true }) });
    const me = async () => (await (await page.request.get("/api/me")).json()).user;
    await page.goto("/");
    await expect(page.locator(".points-value")).toHaveText("30");
    await expect(stat("ゲームの点数").locator("dd")).toHaveText("30");
    await expect(page.locator(".game-awards li", { hasText: gameName })).toContainText("+30");

    // ポイントを伏せる（管理画面の Setting で）：合計・お気に入りに選ばれた数が出ない。ゲームの点数は出る
    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/settings");
    await adm.getByRole("switch", { name: /^参加者のホーム画面にポイントを表示する/ }).uncheck();
    await saveSettings(adm);
    await page.reload();
    await expect(stat("ゲームの点数").locator("dd")).toHaveText("30");
    await expect(page.locator(".points-value")).toHaveCount(0);
    await expect(stat("お気に入りに選ばれた")).toHaveCount(0);
    expect((await me()).points).toBeUndefined();

    // ゲームの点数も伏せる：ゲームの点数と、点数が入ったものも出ない
    await adm.getByRole("switch", { name: /^参加者のホーム画面にゲームの点数を表示する/ }).uncheck();
    await saveSettings(adm);
    await page.reload();
    await expect(stat("公開中の写真")).toBeVisible();
    await expect(stat("ゲームの点数")).toHaveCount(0);
    await expect(page.locator(".game-awards")).toHaveCount(0);
    expect((await me()).gamePoints).toBeUndefined();

    // 幹事には見える
    await adm.goto("/admin/users");
    await expect(adm.locator("tbody tr", { hasText: a.user.name }).locator("td.num strong").first()).toHaveText("30");
  });

  test("P2 同じポイントのときの順位の優先順を並べ替えると、同点の人の順位が変わる", async ({ browser }) => {
    // 先に登録した人はゲームで 10 点、後から登録した人は写真 1 枚で 10 点（同じポイント）
    const first = await participant(browser, admin, unique("同点 先"));
    const second = await participant(browser, admin, unique("同点 後"));
    await updateSettings(admin, { uploadPoints: 10, rankingVisible: true });
    await award(first.user.userId, 10);
    await publishPhoto(second.page);
    await expect.poll(() => homePoints(second.page), { timeout: 20_000 }).toBe(10);
    const { page } = first;

    // 既定は写真のアップロードを先に比べるので、写真の人が上
    await page.goto("/standings");
    expect(await rankOf(page, second.user.name)).toBeLessThan(await rankOf(page, first.user.name));

    // 管理画面の Setting で、ゲームをいちばん上にする
    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/settings");
    const up = adm.getByRole("button", { name: "ゲームを上へ" });
    while (await up.isEnabled()) await up.click();
    await expect(adm.locator(".sortable-label").first()).toHaveText("1. ゲーム");
    await saveSettings(adm);

    await page.reload();
    expect(await rankOf(page, first.user.name)).toBeLessThan(await rankOf(page, second.user.name));
  });
});

test.describe("景品", () => {
  test("P1 景品の名前・画像を変え、画像を外し、削除できる。参加者には上位の景品から並び、順位の無い景品は出ない", async ({
    browser,
  }) => {
    const firstName = unique("E2E 1 位の景品");
    const renamed = unique("E2E 1 位の特賞");
    const secondName = unique("E2E 2 位の景品");
    const unassigned = unique("E2E 割り当てなし");
    // 作る順は 2 位の景品を先にする（参加者の画面の並びが、作った順でないことを確かめる）
    await admin.post("/admin/prizes", { name: secondName, quantity: 1, positions: [2] });
    const { prize } = await admin.post("/admin/prizes", { name: firstName, quantity: 1, positions: [1] });
    await admin.post("/admin/prizes", { name: unassigned, quantity: 1, positions: [] });
    const imageOf = async () =>
      ((await admin.get("/admin/prizes")).prizes as { prizeId: string; imageId?: string }[]).find(
        (p) => p.prizeId === prize.prizeId,
      )?.imageId;

    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/prizes");
    const card = (name: string) =>
      adm.locator("article.prize-card").filter({ has: adm.getByRole("heading", { name, exact: true }) });
    const dialog = adm.locator("dialog[open]");
    const edit = async (name: string) => {
      await card(name).getByRole("button", { name: "編集" }).click();
      await expect(dialog).toBeVisible();
    };
    const save = async () => {
      await dialog.getByRole("button", { name: "保存" }).click();
      await expect(dialog).toHaveCount(0, { timeout: 20_000 });
    };

    // 名前を変え、画像を付ける
    await edit(firstName);
    await expect(dialog.locator(".prize-image.placeholder")).toHaveText("🎁");
    await dialog.getByLabel("名前").fill(renamed);
    await dialog
      .locator("input[type=file]")
      .setInputFiles({ name: "first.jpg", mimeType: "image/jpeg", buffer: await jpeg(adm, "#2980b9") });
    await expect(dialog.getByRole("img", { name: "選んだ画像" })).toBeVisible();
    await save();
    await expect(card(renamed).locator("img.prize-image")).toBeVisible();
    await expect(card(firstName)).toHaveCount(0);
    const firstImage = await imageOf();
    expect(firstImage).toBeTruthy();

    // 画像を差し替える
    await edit(renamed);
    await dialog
      .locator("input[type=file]")
      .setInputFiles({ name: "second.jpg", mimeType: "image/jpeg", buffer: await jpeg(adm, "#8e44ad") });
    await save();
    await expect.poll(imageOf).not.toBe(firstImage);
    expect(await imageOf()).toBeTruthy();

    // 画像を外すと、箱の絵になる
    await edit(renamed);
    await dialog.getByRole("button", { name: "画像を外す" }).click();
    await save();
    await expect.poll(imageOf).toBeUndefined();
    await expect(card(renamed).locator(".prize-image.placeholder")).toHaveText("🎁");
    await expect(card(renamed).locator("img")).toHaveCount(0);
    await expect(card(unassigned)).toContainText("順位に割り当てていません");

    // 参加者には上位の景品から並び、順位の無い景品は出ない。画像の無い景品は箱の絵
    await updateSettings(admin, { prizesVisible: true });
    const a = await participant(browser, admin, "景品 見る");
    await a.page.goto("/standings");
    const items = a.page.locator(".prize-list-item");
    await expect(items.filter({ hasText: renamed })).toBeVisible();
    const names = await a.page.locator(".prize-list-item h3").allTextContents();
    expect(names.indexOf(renamed)).toBeGreaterThanOrEqual(0);
    expect(names.indexOf(renamed)).toBeLessThan(names.indexOf(secondName));
    expect(names).not.toContain(unassigned);
    await expect(items.filter({ hasText: renamed }).locator(".prize-image.placeholder")).toHaveText("🎁");

    // 削除すると、管理画面からも参加者の画面からも消える
    await card(secondName).getByRole("button", { name: "削除" }).click();
    await acceptConfirm(adm);
    await expect(card(secondName)).toHaveCount(0);
    await a.page.reload();
    await expect(items.filter({ hasText: renamed })).toBeVisible();
    await expect(items.filter({ hasText: secondName })).toHaveCount(0);
  });
});

test("P2 管理画面の Trend は、初めは上位 10 人に色が付き、表で選び替えられ、10 人を超えては選べない", async ({
  browser,
}) => {
  // 11 人以上いないと、選べなくなることを確かめられない
  const { ranking } = await admin.get("/admin/ranking");
  for (let i = ranking.length; i < 11; i++) await participant(browser, admin, `推移 ${i + 1}`);

  const { page: adm } = await adminPage(browser);
  await adm.goto("/admin/trend");
  const boxes = adm.getByRole("checkbox", { name: /をグラフで色付きにする$/ });
  const legend = adm.locator(".ranking-legend li");
  await expect(boxes.nth(10)).toBeVisible();
  // 表は順位の順なので、上から 10 人に色が付いている
  for (let i = 0; i < 10; i++) await expect(boxes.nth(i)).toBeChecked();
  await expect(boxes.nth(10)).not.toBeChecked();
  await expect(boxes.nth(10)).toBeDisabled();
  await expect(legend).toHaveCount(10);

  // 1 人外すと、ほかの人を選べる。10 人に戻ると、外した人はもう選べない
  await boxes.nth(0).uncheck();
  await expect(legend).toHaveCount(9);
  await expect(boxes.nth(10)).toBeEnabled();
  await boxes.nth(10).check();
  await expect(legend).toHaveCount(10);
  await expect(boxes.nth(0)).toBeDisabled();
});
