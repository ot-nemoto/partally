import { expect, type Page, test } from "@playwright/test";
import {
  type AdminApi,
  acceptConfirm,
  adminApi,
  adminPage,
  homePoints,
  participant,
  unique,
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
