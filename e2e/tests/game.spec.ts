import { expect, type Page, test } from "@playwright/test";
import {
  type AdminApi,
  acceptConfirm,
  adminApi,
  adminPage,
  homePoints,
  jpeg,
  participant,
  unique,
  updateSettings,
  useDefaultSettings,
} from "./helpers";

/**
 * ゲームの共通の流れ・ラウンド・管理画面の操作（docs/e2e-tests.md の 3 章「ゲーム共通・形式別・ラウンド」と 4 章。#269）。
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

/**
 * テストのたびに、開いたブラウザを閉じ（参加者の画面は 5 秒ごとに確かめるので、後のテストの間に送り続けないように）、
 * 開催中のゲーム・ラウンドを止める（ほかのテストが開始できるように）
 */
test.afterEach(async ({ browser }) => {
  for (const context of browser.contexts()) await context.close();
  if (!admin) return;
  for (const r of (await admin.get("/admin/rounds")).rounds) {
    if (r.status === "open") await admin.post(`/admin/rounds/${r.roundId}/stop`);
  }
  for (const g of (await admin.get("/admin/games")).games) {
    if (g.status === "open" && !g.roundId) await admin.post(`/admin/games/${g.gameId}/stop`);
  }
});

type Game = { gameId: string; name: string; status: string; confirmedAt?: string; storedAnswerCount: number };

/** クイズを下書きで作る（選択肢は「北海道」10 点・「沖縄」0 点）。名前は保存された名前（NFKC でそろう）を返す */
async function createQuiz(name: string, points = 10): Promise<Game> {
  const { game } = await admin.post("/admin/games", {
    format: "quiz",
    name: unique(name),
    choices: [
      { text: "北海道", points },
      { text: "沖縄", points: 0 },
    ],
  });
  return game;
}

/** 結果入力のゲームを下書きで作る（枠「優勝」30 点に userIds の人を入れる） */
async function createResult(name: string, userIds: string[] = []): Promise<Game> {
  const { game } = await admin.post("/admin/games", {
    format: "result",
    name: unique(name),
    slots: [{ name: "優勝", points: 30, userIds }],
  });
  return game;
}

const getGame = async (gameId: string): Promise<Game> =>
  (await admin.get("/admin/games")).games.find((g: Game) => g.gameId === gameId);

/** 管理画面のゲームのカード（名前で探す） */
const gameCard = (page: Page, name: string) =>
  page.locator("article.game-card").filter({ has: page.getByRole("heading", { name, exact: true }) });

/** 管理画面のラウンドのカード（名前で探す） */
const roundCard = (page: Page, name: string) =>
  page.locator("article.round-card").filter({ has: page.getByRole("heading", { name, exact: true }) });

/** API が 409 で断ったこと（エラーの文は「POST /admin/... → 409 {...}」。パスや本文の「409」には当てない） */
const CONFLICT = /→ 409 /;

/** 参加者として答える（画面を通さない準備用） */
async function answer(page: Page, gameId: string, body: Record<string, unknown>) {
  const res = await page.request.put(`/api/game/${gameId}/answer`, { data: body });
  expect(res.ok()).toBe(true);
}

test.describe("ゲーム共通", () => {
  test("P1 開催中は、別のゲームやラウンドを開始できない", async ({ browser }) => {
    const live = await createQuiz("開催中の問題");
    const other = await createQuiz("待っている問題");
    const inRound = await createQuiz("ラウンドの問題");
    const { round } = await admin.post("/admin/rounds", {
      name: unique("待っているラウンド"),
      gameIds: [inRound.gameId],
    });
    await admin.post(`/admin/games/${live.gameId}/open`);

    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/games");
    const card = gameCard(adm, other.name);
    await expect(card.getByRole("button", { name: "開始" })).toBeDisabled();
    await expect(card).toContainText("開催中のゲームを終了するか中断すると、開始できます。");
    await expect(roundCard(adm, round.name).getByRole("button", { name: "開始" })).toBeDisabled();
    // 画面を通さずに送っても断られる
    await expect(admin.post(`/admin/games/${other.gameId}/open`)).rejects.toThrow(CONFLICT);
    await expect(admin.post(`/admin/rounds/${round.roundId}/open`)).rejects.toThrow(CONFLICT);

    // 開催中のゲームを中断すると、開始できるようになる
    await gameCard(adm, live.name).getByRole("button", { name: "中断" }).click();
    await acceptConfirm(adm);
    await expect(card.getByRole("button", { name: "開始" })).toBeEnabled();
    await expect(roundCard(adm, round.name).getByRole("button", { name: "開始" })).toBeEnabled();

    // ラウンドが開催中のときも、ほかのゲームは開始できない
    await admin.post(`/admin/rounds/${round.roundId}/open`);
    await adm.reload();
    await expect(card.getByRole("button", { name: "開始" })).toBeDisabled();
    await expect(card).toContainText("開催中のゲームを終了するか中断すると、開始できます。");
    await expect(admin.post(`/admin/games/${other.gameId}/open`)).rejects.toThrow(CONFLICT);
  });

  test("P1 中断しても答えは残り、開始し直しても答え直せない", async ({ browser }) => {
    const a = await participant(browser, admin, "中断 一郎");
    const quiz = await createQuiz("中断する問題");
    await admin.post(`/admin/games/${quiz.gameId}/open`);
    await a.page.goto("/game");
    await a.page.getByRole("button", { name: "北海道", exact: true }).click();
    await a.page.getByRole("button", { name: "決定" }).click();
    await expect(a.page.locator(".game-done-stamp")).toBeVisible();

    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/games");
    const card = gameCard(adm, quiz.name);
    await card.getByRole("button", { name: "中断" }).click();
    await acceptConfirm(adm);
    await expect(card.locator(".status")).toHaveText("下書き");
    expect((await getGame(quiz.gameId)).storedAnswerCount).toBe(1);

    // 開始し直すと、前の答えのまま（選び直せない）
    await card.getByRole("button", { name: "開始" }).click();
    await expect(card.locator(".status")).toHaveText("開催中");
    await a.page.goto("/game");
    await expect(a.page.getByRole("button", { name: "北海道", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(a.page.getByRole("button", { name: "沖縄", exact: true })).toBeDisabled();
    await expect(a.page.locator(".game-done-stamp")).toBeVisible();
    await expect(a.page.getByRole("button", { name: "決定" })).toHaveCount(0);
  });

  test("P1 終了を取り消すとポイントが消え、もう一度終了すると、その時刻で入り直す", async ({ browser }) => {
    const a = await participant(browser, admin, "取消 二郎");
    const quiz = await createQuiz("取り消す問題");
    await admin.post(`/admin/games/${quiz.gameId}/open`);
    const [hokkaido] = (await (await a.page.request.get("/api/game/current")).json()).games[0].choices;
    await answer(a.page, quiz.gameId, { choiceId: hokkaido.choiceId });
    await admin.post(`/admin/games/${quiz.gameId}/confirm`);
    const firstEnd = (await getGame(quiz.gameId)).confirmedAt!;
    expect(await homePoints(a.page)).toBe(10);

    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/games");
    const card = gameCard(adm, quiz.name);
    await card.getByRole("button", { name: "終了を取り消す" }).click();
    await acceptConfirm(adm);
    await expect(card.locator(".status")).toHaveText("下書き");
    expect(await homePoints(a.page)).toBe(0);
    // 点数が入ったものの一覧（.game-awards）からも消える（ほかに無ければ、一覧ごと出ない）
    await expect(a.page.getByText(quiz.name)).toHaveCount(0);

    // もう一度開始して終了すると、答えはそのままで、終了した時刻でポイントが入る
    await card.getByRole("button", { name: "開始" }).click();
    await card.getByRole("button", { name: "終了" }).click();
    await acceptConfirm(adm);
    await expect(card.locator(".status")).toHaveText("終了");
    const secondEnd = (await getGame(quiz.gameId)).confirmedAt!;
    expect(secondEnd > firstEnd).toBe(true);
    expect(await homePoints(a.page)).toBe(10);
  });

  test("P1 参加者が画面を開いたまま、開始でお知らせが出て、終了で消える", async ({ browser }) => {
    const a = await participant(browser, admin, "お知らせ 三郎");
    const game = await createResult("お知らせの大会", [a.user.userId]);
    await a.page.goto("/");
    const banner = a.page.locator(".quiz-banner");
    await expect(banner).toHaveCount(0);

    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/games");
    const card = gameCard(adm, game.name);
    await card.getByRole("button", { name: "開始" }).click();
    // 参加者の画面は 5 秒ごとに確かめるので、読み込み直さなくても出て、消える
    await expect(banner).toContainText(game.name, { timeout: 15_000 });
    await card.getByRole("button", { name: "終了" }).click();
    await acceptConfirm(adm);
    await expect(banner).toHaveCount(0, { timeout: 15_000 });
  });
});

test.describe("ラウンド", () => {
  test("P1 ラウンドを開始すると全問が番号順に並び、1 問ずつ答え、まとめて終了すると同じ時刻でポイントが入る", async ({
    browser,
  }) => {
    const a = await participant(browser, admin, "ラウンド 四郎");
    const q1 = await createQuiz("第 1 問", 10);
    const q2 = await createQuiz("第 2 問", 5);
    const { round } = await admin.post("/admin/rounds", {
      name: unique("第 1 部"),
      gameIds: [q1.gameId, q2.gameId],
    });

    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/games");
    // ラウンドに入っているゲームは、1 問だけでは開始できない
    const q1Card = gameCard(adm, q1.name);
    await expect(q1Card.locator(".game-round-chip")).toContainText(round.name);
    await expect(q1Card.getByRole("button", { name: "開始" })).toHaveCount(0);
    await expect(admin.post(`/admin/games/${q1.gameId}/open`)).rejects.toThrow(CONFLICT);

    await a.page.goto("/");
    const rCard = roundCard(adm, round.name);
    await rCard.getByRole("button", { name: "開始" }).click();
    await acceptConfirm(adm);
    await expect(rCard.locator(".status")).toHaveText("開催中");
    // ラウンドに入っているゲームは、1 問だけでは終了もできない
    await expect(q1Card.getByRole("button", { name: "終了" })).toHaveCount(0);
    await expect(admin.post(`/admin/games/${q1.gameId}/confirm`)).rejects.toThrow(CONFLICT);

    const banner = a.page.locator(".quiz-banner");
    await expect(banner).toContainText("問題が出ています", { timeout: 15_000 });
    await expect(banner).toContainText(`${round.name}・2 問中 0 問回答済み`);
    await banner.click();
    await expect(a.page.getByRole("heading", { level: 1 })).toHaveText(round.name);
    const items = a.page.locator("li.round-game");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0).locator(".round-game-title")).toHaveText(`1${q1.name}`);
    await expect(items.nth(1).locator(".round-game-title")).toHaveText(`2${q2.name}`);

    // 1 問ずつ答える
    await items.nth(0).getByRole("button", { name: "北海道", exact: true }).click();
    await items.nth(0).getByRole("button", { name: "決定" }).click();
    await expect(items.nth(0).locator(".game-done-stamp")).toBeVisible();
    await expect(items.nth(1).getByRole("button", { name: "決定" })).toBeVisible();
    await a.page.goto("/");
    await expect(banner).toContainText(`${round.name}・2 問中 1 問回答済み`);
    await banner.click();
    await items.nth(1).getByRole("button", { name: "北海道", exact: true }).click();
    await items.nth(1).getByRole("button", { name: "決定" }).click();
    await expect(items.nth(1).locator(".game-done-stamp")).toBeVisible();

    // まとめて終了すると、全問が同じ時刻に終わり、両方の点数が入る
    await rCard.getByRole("button", { name: "終了" }).click();
    await acceptConfirm(adm);
    await expect(rCard.locator(".status")).toHaveText("終了");
    const [g1, g2] = [await getGame(q1.gameId), await getGame(q2.gameId)];
    expect([g1.status, g2.status]).toEqual(["confirmed", "confirmed"]);
    expect(g1.confirmedAt).toBe(g2.confirmedAt);
    expect(await homePoints(a.page)).toBe(15);
  });

  test("P1 ラウンドの管理画面で、作る・ゲームの出し入れ・並べ替え・削除ができ、消しても中のゲームは残る", async ({
    browser,
  }) => {
    const g1 = await createQuiz("出し入れ 1");
    const g2 = await createQuiz("出し入れ 2");
    const g3 = await createQuiz("出し入れ 3");
    const name = unique("管理のラウンド");
    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/games");

    await adm.locator(".rounds-head").getByRole("button", { name: "ラウンドを作る" }).click();
    const dialog = adm.locator("dialog[open]");
    await dialog.getByLabel("名前").fill(name);
    for (const g of [g1, g2, g3]) {
      await dialog.locator("li", { hasText: g.name }).getByRole("button", { name: "追加" }).click();
    }
    const chosen = dialog.locator("ol.round-dialog-list > li");
    await expect(chosen).toHaveCount(3);
    // 3 問目を 1 つ上へ動かし、2 問目を外す
    await chosen.filter({ hasText: g3.name }).getByRole("button", { name: "上へ" }).click();
    await chosen.filter({ hasText: g2.name }).getByRole("button", { name: "外す" }).click();
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog).toHaveCount(0);

    const card = roundCard(adm, name);
    const listed = card.locator("ol.round-card-games > li");
    await expect(listed).toHaveCount(2);
    await expect(listed.nth(0)).toContainText(g1.name);
    await expect(listed.nth(1)).toContainText(g3.name);
    const mine = (await admin.get("/admin/rounds")).rounds.find((r: { name: string }) => r.name === name);
    expect(mine.gameIds).toEqual([g1.gameId, g3.gameId]);
    await expect(gameCard(adm, g2.name).locator(".game-round-chip")).toHaveCount(0);

    // ラウンドの並べ替え：後ろに足したラウンドを「上へ」で 1 つ前に出す
    const { round: later } = await admin.post("/admin/rounds", { name: unique("後のラウンド"), gameIds: [] });
    await adm.reload();
    await roundCard(adm, later.name).getByRole("button", { name: "上へ" }).click();
    await expect
      .poll(async () => {
        const ids = (await admin.get("/admin/rounds")).rounds.map((r: { roundId: string }) => r.roundId);
        return ids.indexOf(later.roundId) < ids.indexOf(mine.roundId);
      })
      .toBe(true);

    // ラウンドを削除しても、中のゲームは残り、1 問ずつ開始できるようになる
    await card.getByRole("button", { name: "削除" }).click();
    await acceptConfirm(adm);
    await expect(card).toHaveCount(0);
    for (const g of [g1, g3]) {
      expect((await getGame(g.gameId))?.status).toBe("draft");
      await expect(gameCard(adm, g.name).locator(".game-round-chip")).toHaveCount(0);
      await expect(gameCard(adm, g.name).getByRole("button", { name: "開始" })).toBeVisible();
    }
  });

  test("P2 終了できない問題を含むラウンドは、終了が止まって問題ごとの理由が出る", async ({ browser }) => {
    const quiz = await createQuiz("終われるクイズ");
    const { game: number } = await admin.post("/admin/games", {
      format: "number",
      name: unique("正解の無い数値予想"),
      ranks: [{ from: 1, to: 1, points: 10 }],
    });
    const { round } = await admin.post("/admin/rounds", {
      name: unique("終われないラウンド"),
      gameIds: [quiz.gameId, number.gameId],
    });
    await admin.post(`/admin/rounds/${round.roundId}/open`);

    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/games");
    let message = "";
    adm.once("dialog", (d) => {
      message = d.message();
      void d.accept();
    });
    await roundCard(adm, round.name).getByRole("button", { name: "終了" }).click();
    await expect.poll(() => message).toContain("終了できない問題があります。");
    expect(message).toContain(`「${number.name}」: 正解の数を入れてから終了してください`);
    expect(message).not.toContain(quiz.name);
    // 確認の画面に進まず、ラウンドは開催中のまま
    await expect(adm.locator("dialog.confirm-dialog[open]")).toHaveCount(0);
    const rounds = (await admin.get("/admin/rounds")).rounds;
    expect(rounds.find((r: { roundId: string }) => r.roundId === round.roundId).status).toBe("open");
  });
});

test.describe("ゲームの編集・プレビュー・一覧", () => {
  test("P2 開催中・終了したゲームを直すと参加者の画面とポイントに出て、プレビューでは答えを試せるが保存されず、点数は出ない", async ({
    browser,
  }) => {
    const a = await participant(browser, admin, "編集 五郎");
    const quiz = await createQuiz("直す問題");
    await admin.post(`/admin/games/${quiz.gameId}/open`);
    const [hokkaido] = (await (await a.page.request.get("/api/game/current")).json()).games[0].choices;
    await answer(a.page, quiz.gameId, { choiceId: hokkaido.choiceId });
    await admin.post(`/admin/games/${quiz.gameId}/confirm`);
    expect(await homePoints(a.page)).toBe(10);

    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/games");
    const card = gameCard(adm, quiz.name);
    await card.getByRole("button", { name: "編集" }).click();
    const form = adm.locator("dialog.game-dialog[open]");
    // 名前はラベルの「点数」と、範囲の案内（0〜100）をつなげたもの
    await form.getByRole("textbox", { name: /^点数/ }).first().fill("25");
    await form.getByRole("button", { name: "保存" }).click();
    await expect(form).toHaveCount(0);
    await expect.poll(() => homePoints(a.page)).toBe(25);

    // プレビュー：参加者の画面と同じ部品で答えを試せるが、保存されず、点数は出ない
    await card.getByRole("button", { name: "プレビュー" }).click();
    const preview = adm.locator("dialog.game-preview-dialog[open]");
    await expect(preview.locator(".quiz-banner")).toContainText("問題が出ています");
    // 中身が出てから、出ないものを確かめる
    await expect(preview.getByRole("button", { name: "北海道", exact: true })).toBeVisible();
    // 点数（「25 点」など）は出さない
    await expect(preview).not.toContainText("点");
    await preview.getByRole("button", { name: "沖縄", exact: true }).click();
    await preview.getByRole("button", { name: "決定" }).click();
    await expect(preview.locator(".game-done-stamp")).toBeVisible();
    await preview.getByRole("button", { name: "閉じる" }).click();
    expect((await getGame(quiz.gameId)).storedAnswerCount).toBe(1);
    expect(await homePoints(a.page)).toBe(25);

    // 開催中のゲームも直せて、参加者の画面（お知らせ）にすぐ出る
    const live = await createQuiz("開催中に直す問題");
    await admin.post(`/admin/games/${live.gameId}/open`);
    await a.page.goto("/");
    await expect(a.page.locator(".quiz-banner")).toContainText(live.name);
    await adm.reload();
    await gameCard(adm, live.name).getByRole("button", { name: "編集" }).click();
    const renamed = unique("開催中に直した問題");
    await form.getByLabel("名前", { exact: true }).fill(renamed);
    await form.getByRole("button", { name: "保存" }).click();
    await expect(form).toHaveCount(0);
    await expect(a.page.locator(".quiz-banner")).toContainText(renamed, { timeout: 15_000 });
    await admin.post(`/admin/games/${live.gameId}/stop`);

    // 合言葉のプレビュー：合言葉は出ないが、試すと正解か分かる。保存はしない
    const keyword = "ひみつのことば";
    const { game: kw } = await admin.post("/admin/games", {
      format: "keyword",
      name: unique("合言葉のプレビュー"),
      keyword,
      ranks: [{ from: 1, to: 3, points: 10 }],
    });
    await adm.reload();
    await gameCard(adm, kw.name).getByRole("button", { name: "プレビュー" }).click();
    const input = preview.getByRole("textbox");
    await expect(input).toBeVisible();
    await expect(preview).not.toContainText(keyword);
    await input.fill("ちがうことば");
    await preview.getByRole("button", { name: "送る" }).click();
    await expect(preview.locator(".game-keyword-result.wrong")).toBeVisible();
    await input.fill(keyword);
    await preview.getByRole("button", { name: "送る" }).click();
    await expect(preview).toContainText("正解です！");
    expect((await getGame(kw.gameId)).storedAnswerCount).toBe(0);
  });

  test("P2 一覧は新しい順に「第 N ゲーム」の番号が付き、状態の絞り込みを覚え、開催中でなければ削除できる", async ({
    browser,
  }) => {
    const older = await createQuiz("先に作った問題");
    const newer = await createQuiz("後に作った問題");
    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/games");

    // 新しいゲームが上。番号は作った順（一覧が出てから読む）
    await expect(gameCard(adm, older.name)).toBeVisible();
    await expect(gameCard(adm, newer.name)).toBeVisible();
    const names = await adm.locator("article.game-card h2.game-name").allTextContents();
    expect(names.indexOf(newer.name)).toBeGreaterThanOrEqual(0);
    expect(names.indexOf(newer.name)).toBeLessThan(names.indexOf(older.name));
    const numberOf = async (name: string) =>
      Number((await gameCard(adm, name).locator("header").textContent())?.match(/第 (\d+) ゲーム/)?.[1]);
    expect(await numberOf(newer.name)).toBe((await numberOf(older.name)) + 1);

    // 開催中のゲームは削除できない（同じ所に「中断」が出る）
    await admin.post(`/admin/games/${newer.gameId}/open`);
    await adm.reload();
    await expect(gameCard(adm, newer.name).getByRole("button", { name: "削除" })).toHaveCount(0);
    await expect(gameCard(adm, newer.name).getByRole("button", { name: "中断" })).toBeVisible();
    await expect(admin.del(`/admin/games/${newer.gameId}`)).rejects.toThrow(CONFLICT);
    await admin.post(`/admin/games/${newer.gameId}/stop`);

    // 下書きは削除できる
    await adm.reload();
    await gameCard(adm, older.name).getByRole("button", { name: "削除" }).click();
    await acceptConfirm(adm);
    await expect(gameCard(adm, older.name)).toHaveCount(0);
    expect(await getGame(older.gameId)).toBeUndefined();

    // 状態の絞り込み：下書きを隠すと出なくなり、読み込み直しても隠したまま
    const draftFilter = adm.getByRole("button", { name: /^下書き（\d+）$/ });
    await draftFilter.click();
    await expect(draftFilter).toHaveAttribute("aria-pressed", "false");
    await expect(gameCard(adm, newer.name)).toHaveCount(0);
    await expect(adm.getByText(/\d+ 件を非表示にしています。/)).toBeVisible();
    await adm.reload();
    await expect(draftFilter).toHaveAttribute("aria-pressed", "false");
    await expect(gameCard(adm, newer.name)).toHaveCount(0);
    await draftFilter.click();
    await expect(gameCard(adm, newer.name)).toBeVisible();
  });

  test("P2 2 つの管理画面で同じゲームを直すと、後から保存した方は上書きせずに知らせる", async ({ browser }) => {
    const quiz = await createQuiz("同時に直す問題");
    const first = await adminPage(browser);
    const second = await adminPage(browser);
    const open = async (page: Page) => {
      await page.goto("/admin/games");
      await gameCard(page, quiz.name).getByRole("button", { name: "編集" }).click();
      return page.locator("dialog.game-dialog[open]");
    };
    const [form1, form2] = [await open(first.page), await open(second.page)];

    const name1 = unique("先に直した名前");
    await form1.getByLabel("名前", { exact: true }).fill(name1);
    await form1.getByRole("button", { name: "保存" }).click();
    await expect(form1).toHaveCount(0);

    await form2.getByLabel("名前", { exact: true }).fill(unique("後から直した名前"));
    await form2.getByRole("button", { name: "保存" }).click();
    await expect(form2.locator(".error")).toContainText("ほかの画面でこのゲームが変更されました");
    expect((await getGame(quiz.gameId)).name).toBe(name1);
  });
});

/** ゲームを下書きで作る（作るときの本文をそのまま送る。名前は unique() で変える） */
async function createGame(body: Record<string, unknown> & { name: string }): Promise<Game> {
  const { game } = await admin.post("/admin/games", { ...body, name: unique(body.name) });
  return game;
}

/** 参加者のホームの、そのゲームで点数が入った行 */
const awardOf = (page: Page, gameName: string) => page.locator(".game-awards li", { hasText: gameName });

/** 管理画面で、そのゲームの「回答者を見る」を開く */
async function openAnswers(adm: Page, name: string) {
  await adm.goto("/admin/games");
  await gameCard(adm, name).getByRole("button", { name: "回答者を見る" }).click();
  return adm.locator("dialog.game-dialog[open]");
}

test.describe("形式別", () => {
  test("P1 数値予想：正解の数を入れないと終了できず、終了後は近い順の順位と点数がホームに出る", async ({ browser }) => {
    const a = await participant(browser, admin, unique("予想 一郎"));
    const b = await participant(browser, admin, unique("予想 二郎"));
    const game = await createGame({
      format: "number",
      name: "飴の数",
      ranks: [
        { from: 1, to: 1, points: 10 },
        { from: 2, to: 3, points: 5 },
      ],
    });
    await admin.post(`/admin/games/${game.gameId}/open`);

    await a.page.goto("/");
    await expect(a.page.locator(".quiz-banner")).toContainText("問題が出ています");
    await a.page.goto("/game");
    await a.page.getByRole("textbox", { name: /^予想する数/ }).fill("40");
    await a.page.getByRole("button", { name: "決定" }).click();
    // 決定した後は答え直せない
    await expect(a.page.locator(".game-number-mine")).toHaveText("40");
    await expect(a.page.locator(".game-done-stamp")).toBeVisible();
    await expect(a.page.getByRole("textbox", { name: /^予想する数/ })).toHaveCount(0);
    await answer(b.page, game.gameId, { value: 42 });

    // 正解の数が無いうちは終了できず、理由が出る
    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/games");
    const card = gameCard(adm, game.name);
    const end = card.getByRole("button", { name: "終了" });
    await expect(end).toBeDisabled();
    await expect(end).toHaveAttribute("title", "正解の数を入れてから終了してください");
    await expect(card).toContainText("未設定（「編集」で入れると終了できます）");

    await card.getByRole("button", { name: "編集" }).click();
    const form = adm.locator("dialog.game-dialog[open]");
    await form.getByRole("textbox", { name: /^正解の数/ }).fill("43");
    await form.getByRole("button", { name: "保存" }).click();
    await expect(form).toHaveCount(0);
    await expect(card).toContainText("正解の数: 43");
    await end.click();
    await acceptConfirm(adm);
    await expect(card.locator(".status")).toHaveText("終了");

    // 差が 3 の a は 2 位で 5 点、差が 1 の b は 1 位で 10 点
    await a.page.goto("/");
    await expect(awardOf(a.page, game.name)).toContainText("2 位（予想 40）");
    await expect(awardOf(a.page, game.name)).toContainText("+5");
    await b.page.goto("/");
    await expect(awardOf(b.page, game.name)).toContainText("1 位（予想 42）");
    await expect(awardOf(b.page, game.name)).toContainText("+10");
  });

  test("P1 投票：名前・二つ名で絞り込めて自分は選べず、参加者には票が見えず、幹事には集計が見える", async ({
    browser,
  }) => {
    // 投票の候補は、ランキングの「名前を伏せる」に関係なく名前を出す
    await updateSettings(admin, { rankingVisible: true, rankingHideNames: true });
    const a = await participant(browser, admin, unique("投票 一郎"));
    const b = await participant(browser, admin, unique("投票 二郎"));
    const c = await participant(browser, admin, unique("投票 三郎"));
    const game = await createGame({
      format: "vote",
      name: "ベストドレッサー",
      ranks: [{ from: 1, to: 1, points: 30 }],
      voterPoints: 5,
    });
    await admin.post(`/admin/games/${game.gameId}/open`);

    await a.page.goto("/");
    await expect(a.page.locator(".quiz-banner")).toContainText("投票受付中");
    await a.page.goto("/game");
    const search = a.page.getByRole("searchbox", { name: "名前・二つ名で探す" });
    const list = a.page.locator(".game-vote-list");
    // 自分は候補に出ない
    await search.fill(a.user.name);
    await expect(a.page.getByText("見つかりません。")).toBeVisible();
    // 二つ名で絞り込める（二つ名は全員で重ならない）。名前は伏せずに出る
    await search.fill(b.user.epithet);
    await expect(list.getByRole("button")).toHaveCount(1);
    await expect(list).toContainText(b.user.name);
    await list.getByRole("button").click();
    await a.page.locator(".game-decide-bar").getByRole("button", { name: "決定" }).click();
    await expect(a.page.locator(".game-vote-mine")).toContainText(b.user.name);
    await expect(a.page.locator(".game-done-stamp")).toBeVisible();
    await answer(c.page, game.gameId, { targetUserId: b.user.userId });

    // 参加者には票数（「2 票」など）が見えない
    await a.page.reload();
    await expect(a.page.locator(".game-vote-mine")).toContainText(b.user.name);
    await expect(a.page.locator("main")).not.toContainText(/\d+\s*票/);

    // 幹事には、順位・票数・点数と、投票した人が見える
    const { page: adm } = await adminPage(browser);
    const dialog = await openAnswers(adm, game.name);
    const row = dialog.locator("tr", { hasText: b.user.name });
    await expect(row.locator("td").nth(0)).toHaveText("1 位");
    await expect(row.locator("td").nth(2)).toHaveText("2");
    await expect(row.locator("td").nth(3)).toHaveText("30 点");
    await expect(row.locator(".game-voters")).toContainText(a.user.name);
    await expect(row.locator(".game-voters")).toContainText(c.user.name);

    await admin.post(`/admin/games/${game.gameId}/confirm`);
    await b.page.goto("/");
    await expect(awardOf(b.page, game.name)).toContainText("1 位（2 票）");
    await expect(awardOf(b.page, game.name)).toContainText("+30");
    await a.page.goto("/");
    await expect(awardOf(a.page, game.name)).toContainText("投票");
    await expect(awardOf(a.page, game.name)).toContainText("+5");
  });

  test("P1 合言葉：不正解なら何度でも試せ、表記ゆれでも正解になり、正解した後は送れない", async ({ browser }) => {
    const a = await participant(browser, admin, unique("合言葉 一郎"));
    const b = await participant(browser, admin, unique("合言葉 二郎"));
    const game = await createGame({
      format: "keyword",
      name: "会場の合言葉",
      keyword: "パーティー",
      ranks: [{ from: 1, to: 3, points: 10 }],
    });
    await admin.post(`/admin/games/${game.gameId}/open`);

    await a.page.goto("/");
    await expect(a.page.locator(".quiz-banner")).toContainText("合言葉を受付中");
    await a.page.goto("/game");
    const input = a.page.getByRole("textbox", { name: "合言葉" });
    await input.fill("パーテー");
    await a.page.getByRole("button", { name: "送る" }).click();
    await expect(a.page.getByText("ちがいます。もう一度どうぞ。")).toBeVisible();
    // 半角カナでも正解になる
    await input.fill("ﾊﾟｰﾃｨｰ");
    await a.page.getByRole("button", { name: "送る" }).click();
    await expect(a.page.getByText("正解です！")).toBeVisible();
    await expect(a.page.getByRole("textbox", { name: "合言葉" })).toHaveCount(0);
    await expect(a.page.getByRole("button", { name: "送る" })).toHaveCount(0);
    // ひらがなでも正解になる
    const res = await b.page.request.put(`/api/game/${game.gameId}/answer`, { data: { text: "ぱーてぃー" } });
    expect((await res.json()).correct).toBe(true);

    // 幹事には正解した順に出る。不正解の言葉は残らない
    const { page: adm } = await adminPage(browser);
    const dialog = await openAnswers(adm, game.name);
    await expect(dialog).toContainText("正解 2 人");
    await expect(dialog.locator("tbody tr").nth(0)).toContainText(a.user.name);
    await expect(dialog.locator("tbody tr").nth(1)).toContainText(b.user.name);
    await expect(dialog).not.toContainText("パーテー");

    await admin.post(`/admin/games/${game.gameId}/confirm`);
    await a.page.goto("/");
    await expect(awardOf(a.page, game.name)).toContainText("1 番目に正解");
    await expect(awardOf(a.page, game.name)).toContainText("+10");
  });

  test("P1 抽選：参加は 1 回だけで、終了で当選が決まり、幹事には順番と抽選に入らなかった人が出て、取り消すと引き直しになる", async ({
    browser,
  }) => {
    const a = await participant(browser, admin, unique("抽選 一郎"));
    const b = await participant(browser, admin, unique("抽選 二郎"));
    const c = await participant(browser, admin, unique("抽選 三郎"));
    const game = await createGame({
      format: "lottery",
      name: "お楽しみ抽選",
      ranks: [
        { from: 1, to: 1, points: 30 },
        { from: 2, to: 5, points: 10 },
      ],
    });
    await admin.post(`/admin/games/${game.gameId}/open`);

    await a.page.goto("/");
    await expect(a.page.locator(".quiz-banner")).toContainText("抽選の参加受付中");
    await a.page.goto("/game");
    await a.page.getByRole("button", { name: "参加する" }).click();
    await expect(a.page.getByText("参加しました")).toBeVisible();
    await expect(a.page.locator(".game-done-stamp")).toBeVisible();
    await a.page.reload();
    await expect(a.page.getByRole("button", { name: "参加する" })).toHaveCount(0);
    // 2 回目の参加は断られる
    const again = await a.page.request.put(`/api/game/${game.gameId}/answer`, { data: { entry: true } });
    expect(again.status()).toBe(409);
    await answer(b.page, game.gameId, { entry: true });
    await answer(c.page, game.gameId, { entry: true });
    // 参加した後に紐づけを解除された人は、抽選に入らない
    await admin.post(`/admin/users/${c.user.userId}/unbind`);

    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/games");
    const card = gameCard(adm, game.name);
    await card.getByRole("button", { name: "終了" }).click();
    await acceptConfirm(adm);
    await expect(card.locator(".status")).toHaveText("終了");
    const order: string[] = (await admin.get("/admin/games")).games.find(
      (g: Game) => g.gameId === game.gameId,
    ).drawOrder;
    expect([...order].sort()).toEqual([a.user.userId, b.user.userId].sort());

    // 幹事には、当選した人が順番どおりに出て、抽選に入らなかった人も出る
    const dialog = await openAnswers(adm, game.name);
    const rows = dialog.locator("tbody tr");
    const nameOf = (id: string) => (id === a.user.userId ? a.user.name : b.user.name);
    await expect(rows.nth(0)).toContainText(nameOf(order[0]!));
    await expect(rows.nth(0)).toContainText("1 等");
    await expect(rows.nth(1)).toContainText(nameOf(order[1]!));
    await expect(dialog).toContainText("抽選に入っていない参加者（1 人）");
    await expect(dialog).toContainText(c.user.name);
    await dialog.getByRole("button", { name: "閉じる" }).click();

    // 1 番目に引かれた人のホームに「1 等に当選 +30」が出る
    const first = order[0] === a.user.userId ? a : b;
    await first.page.goto("/");
    await expect(awardOf(first.page, game.name)).toContainText("1 等に当選");
    await expect(awardOf(first.page, game.name)).toContainText("+30");

    // 終了を取り消すときは、引き直しになることを知らせる。取り消すと順番も消える
    await card.getByRole("button", { name: "終了を取り消す" }).click();
    await expect(adm.locator("dialog.confirm-dialog[open]")).toContainText("引き直しになります");
    await acceptConfirm(adm);
    await expect(card.locator(".status")).toHaveText("下書き");
    expect((await admin.get("/admin/games")).games.find((g: Game) => g.gameId === game.gameId).drawOrder).toBeFalsy();
  });

  test("P2 画像付きのクイズ（問題と選択肢）では、選択肢が画像付きの大きいボタン（2 列）になる", async ({ browser }) => {
    const a = await participant(browser, admin, unique("画像 一郎"));
    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/games");
    const name = unique("この写真はどこ？").normalize("NFKC");

    // 管理画面で、問題と選択肢に画像を付けて作る（選択肢 3 は画像なし）
    await adm.getByRole("button", { name: "ゲームを作る" }).click();
    const form = adm.locator("dialog.game-dialog[open]");
    await form.getByLabel("名前", { exact: true }).fill(name);
    await form
      .locator("input[type=file]")
      .first()
      .setInputFiles({
        name: "question.jpg",
        mimeType: "image/jpeg",
        buffer: await jpeg(adm, "#8e44ad"),
      });
    for (const [i, text] of ["海", "山", "川"].entries()) {
      await form.getByRole("textbox", { name: new RegExp(`^選択肢 ${i + 1}`) }).fill(text);
      if (i < 2) {
        await form
          .locator(".field", { hasText: `選択肢 ${i + 1} の画像` })
          .locator("input[type=file]")
          .setInputFiles({ name: `choice${i}.jpg`, mimeType: "image/jpeg", buffer: await jpeg(adm, "#16a085") });
      }
    }
    const save = form.getByRole("button", { name: "保存" });
    await expect(save).toBeEnabled({ timeout: 20_000 });
    await save.click();
    await expect(form).toHaveCount(0, { timeout: 20_000 });

    const game: Game = (await admin.get("/admin/games")).games.find((g: Game) => g.name === name);
    await admin.post(`/admin/games/${game.gameId}/open`);
    await a.page.goto("/game");
    // 問題の画像と、選択肢の画像が読み込まれる
    const question = a.page.getByRole("img", { name: "問題の画像" });
    await expect(question).toBeVisible();
    await expect.poll(() => question.evaluate((e) => (e as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const choices = a.page.locator(".quiz-choices.with-images");
    await expect(choices.locator(".quiz-choice-image")).toHaveCount(2);
    await expect
      .poll(() =>
        choices
          .locator(".quiz-choice-image")
          .evaluateAll((els) => els.every((e) => (e as HTMLImageElement).naturalWidth > 0)),
      )
      .toBe(true);
    // スマホの幅で 2 列に並ぶ
    const columns = await choices.evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(" ").length);
    expect(columns).toBe(2);
  });

  test("P2 結果入力の人選びで、絞り込み・全員の選択と解除・複数選択ができ、ほかの枠の人を選ぶと枠が移る", async ({
    browser,
  }) => {
    const tag = unique("人選び");
    const a = await participant(browser, admin, `${tag} 一`);
    const b = await participant(browser, admin, `${tag} 二`);
    const game = await createGame({
      format: "result",
      name: "人選びの大会",
      slots: [
        { name: "優勝", points: 30, userIds: [] },
        { name: "準優勝", points: 20, userIds: [] },
      ],
    });
    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/games");
    const card = gameCard(adm, game.name);
    const picker = adm.locator("dialog.game-dialog[open]");
    const count = picker.locator(".member-picker-count");

    // 絞り込みと、表示中の全員の選択・選択の解除
    await card.getByRole("button", { name: "優勝の人を選ぶ", exact: true }).click();
    await picker.getByRole("searchbox", { name: "絞り込み" }).fill(tag);
    await expect(picker.locator(".member-list li")).toHaveCount(2);
    await picker.getByRole("button", { name: "表示中の人を全員選ぶ" }).click();
    await expect(count).toHaveText("2 人を選択中");
    await picker.getByRole("button", { name: "選択を外す" }).click();
    await expect(count).toHaveText("0 人を選択中");
    // チェックで選ぶ（a だけ）
    await picker.locator(".member-list li", { hasText: a.user.name }).getByRole("checkbox").check();
    await picker.getByRole("button", { name: "保存" }).click();
    await expect(picker).toHaveCount(0);
    // 「優勝」が「準優勝」に当たらないよう、枠の名前は完全一致で探す
    const slot = (slotName: string) =>
      card
        .locator(".game-slots > li")
        .filter({ has: adm.locator(".game-slot-head strong").getByText(slotName, { exact: true }) });
    await expect(slot("優勝").locator(".game-slot-members")).toHaveText(new RegExp(a.user.name));

    // 絞り込まずに「全員を選ぶ」と、一覧の全員が選ばれる（保存しない）
    await card.getByRole("button", { name: "準優勝の人を選ぶ", exact: true }).click();
    await picker.getByRole("button", { name: "全員を選ぶ" }).click();
    const all = await picker.locator(".member-list li").count();
    await expect(count).toHaveText(`${all} 人を選択中`);
    await picker.getByRole("button", { name: "選択を外す" }).click();

    // ほかの枠（優勝）の a と、b を選ぶと、a は準優勝に移る
    await picker.getByRole("searchbox", { name: "絞り込み" }).fill(tag);
    const aRow = picker.locator(".member-list li", { hasText: a.user.name });
    await expect(aRow.locator(".member-other")).toHaveText("優勝");
    await aRow.getByRole("checkbox").check();
    await picker.locator(".member-list li", { hasText: b.user.name }).getByRole("checkbox").check();
    await expect(picker).toContainText("ほかの枠に入っている 1 人は、この枠に移ります。");
    await picker.getByRole("button", { name: "保存" }).click();
    await expect(picker).toHaveCount(0);
    await expect(slot("優勝").locator(".game-slot-members")).toHaveText("まだ選んでいません");
    await expect(slot("準優勝").locator(".game-slot-members")).toContainText(a.user.name);
    await expect(slot("準優勝").locator(".game-slot-members")).toContainText(b.user.name);
  });
});
