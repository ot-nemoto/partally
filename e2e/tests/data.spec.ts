import { readFileSync, writeFileSync } from "node:fs";
import { buildDataArchive, DATA_ARCHIVE_MANIFEST } from "@partally/shared/data-archive";
import { buildGameArchive, type ManifestGame, parseGames } from "@partally/shared/game-archive";
import { buildPrizeArchive, type ManifestPrize, parsePrizes } from "@partally/shared/prize-archive";
import { buildScheduleFile, parseSchedule, type ScheduleFileItem } from "@partally/shared/schedule-file";
import { expect, type Page, test } from "@playwright/test";
import { DEFAULT_SETTINGS } from "../../api/src/repository.js";
import { readArchive } from "../../packages/shared/src/archive.js";
import {
  type AdminApi,
  acceptConfirm,
  adminApi,
  adminPage,
  deleteScheduleItems,
  jpeg,
  unique,
  updateSettings,
  useDefaultSettings,
} from "./helpers";

/**
 * データの移行（機能仕様書 D-1・D-2。#271）：管理画面の Data で ZIP を書き出し、取り込む。
 * docs/e2e-tests.md の 3 章「公開・設定・移行・言語・景品・スケジュール」と 4 章。
 *
 * 空の環境は用意できない（API は 1 つで、データの入った環境へも流す）ので、今のデータは消さずに「追加」で取り込む。
 * 書き出した ZIP には環境のすべてのゲーム・景品・スケジュールが入る（取り込むと、環境のデータがその分だけ増える）ので、
 * このテストで作ったものだけを抜き出した ZIP を作り直して取り込む
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

/** このテストで作ったスケジュールの項目のタイトル（テストの終わりに消す。schedule.spec.ts と同じ理由） */
let titles: string[] = [];
test.afterEach(async ({ browser }) => {
  for (const context of browser.contexts()) await context.close();
  if (admin) await deleteScheduleItems(admin, titles);
  titles = [];
});

type Game = { gameId: string; name: string; status: string; format: string; correctNumber?: number };
type Round = { roundId: string; name: string; gameIds: string[] };
type Prize = { prizeId: string; name: string; imageId?: string; positions: number[] };
type Item = { itemId: string; title: string; hidden: boolean };

const gamesNamed = async (name: string): Promise<Game[]> =>
  ((await admin.get("/admin/games")).games as Game[]).filter((g) => g.name === name);
const prizesNamed = async (name: string): Promise<Prize[]> =>
  ((await admin.get("/admin/prizes")).prizes as Prize[]).filter((p) => p.name === name);
const itemsTitled = async (title: string): Promise<Item[]> =>
  ((await admin.get("/admin/schedule")).items as Item[]).filter((i) => i.title === title);

/** Data の「ファイルを選ぶ」でファイルを選ぶ */
async function chooseFile(adm: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  const chooser = adm.waitForEvent("filechooser");
  await adm.getByRole("button", { name: "ファイルを選ぶ" }).click();
  await (await chooser).setFiles(file);
}

/** ファイルを選び、取り込めないときの知らせ（window.alert）の文を返す */
async function rejectedMessage(adm: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  const message = new Promise<string>((resolve) => {
    adm.once("dialog", (d) => {
      resolve(d.message());
      void d.accept();
    });
  });
  await chooseFile(adm, file);
  return message;
}

test("P1 ZIP に書き出したゲーム（ラウンドを含む）・景品（画像を含む）・スケジュール（見せない列と日付）・設定を、取り込むと戻せる", async ({
  browser,
}) => {
  const quizName = unique("E2E 移行のクイズ");
  const numberName = unique("E2E 移行の数値予想");
  const roundName = unique("E2E 移行のラウンド");
  const prizeName = unique("E2E 移行の景品");
  const itemTitle = unique("E2E 移行の見せない");
  titles.push(itemTitle);
  const date = "2026-12-20";

  // 準備：ラウンドに入れた 2 問、画像付きの景品（画面から）、見せない列の項目、イベントの日付と設定
  const { game: quiz } = await admin.post("/admin/games", {
    format: "quiz",
    name: quizName,
    description: "どちらでしょう",
    choices: [
      { text: "北海道", points: 10 },
      { text: "沖縄", points: 0 },
    ],
  });
  const { game: number } = await admin.post("/admin/games", {
    format: "number",
    name: numberName,
    correctNumber: 42,
    ranks: [{ from: 1, to: 1, points: 10 }],
  });
  await admin.post("/admin/rounds", { name: roundName, gameIds: [quiz.gameId, number.gameId] });
  await admin.post("/admin/schedule", {
    title: itemTitle,
    detail: "移すと見せないまま",
    startMinute: 4 * 60,
    durationMinutes: 30,
    column: 49,
    hidden: true,
  });
  await updateSettings(admin, { uploadPoints: 7, rankingVisible: true, scheduleDate: date });
  const { page: adm } = await adminPage(browser);
  await adm.goto("/admin/prizes");
  await adm.getByRole("button", { name: "景品を登録" }).click();
  const prizeDialog = adm.locator("dialog[open]");
  await prizeDialog.getByLabel("名前").fill(prizeName);
  await prizeDialog.getByPlaceholder("例: 1, 3, 5-10").fill("1");
  await prizeDialog
    .locator("input[type=file]")
    .setInputFiles({ name: "prize.jpg", mimeType: "image/jpeg", buffer: await jpeg(adm, "#16a085") });
  await prizeDialog.getByRole("button", { name: "保存" }).click();
  await expect(prizeDialog).toHaveCount(0, { timeout: 20_000 });

  // 書き出す（すべての種類を選んだまま）
  await adm.goto("/admin/data");
  const exportButton = adm.getByRole("button", { name: "エクスポート", exact: true });
  await expect(exportButton).toBeEnabled();
  const download = adm.waitForEvent("download", { timeout: 60_000 });
  await exportButton.click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^partally-data-.+\.zip$/);
  await expect(adm.getByText("ゲーム・景品・スケジュール・設定を書き出しました。")).toBeVisible();

  // ZIP の中身：このテストで作ったものが、ラウンド・画像・見せない列・日付・設定ごと入っている
  const contents = readArchive(new Uint8Array(readFileSync((await file.path())!)), DATA_ARCHIVE_MANIFEST);
  expect(contents.ok, contents.ok ? "" : contents.error).toBe(true);
  if (!contents.ok) return;
  const manifest = contents.manifest as {
    games: ManifestGame[];
    prizes: ManifestPrize[];
    schedule: { date?: string; items: ScheduleFileItem[] };
    settings: Record<string, unknown>;
  };
  const games = manifest.games.filter((g) => g.name === quizName || g.name === numberName);
  expect(games.map((g) => [g.name, g.round?.name, g.round?.index])).toEqual([
    [quizName, roundName, 0],
    [numberName, roundName, 1],
  ]);
  const prizes = manifest.prizes.filter((p) => p.name === prizeName);
  expect(prizes).toHaveLength(1);
  expect(prizes[0]!.image).toBeTruthy();
  const items = manifest.schedule.items.filter((i) => i.title === itemTitle);
  expect(items.map((i) => i.hidden)).toEqual([true]);
  expect(manifest.schedule.date).toBe(date);
  expect(manifest.settings.uploadPoints).toBe(7);

  // このテストで作ったものだけの ZIP にする（書き出した ZIP と同じ読み方で、画像も含めて読む）
  const parsedGames = parseGames(games, contents.file);
  const parsedPrizes = parsePrizes(prizes, contents.file);
  const parsedSchedule = parseSchedule({ ...manifest.schedule, items });
  if (!parsedGames.ok || !parsedPrizes.ok || !parsedSchedule.ok) throw new Error("書き出した ZIP を読めない");
  expect(parsedPrizes.prizes[0]!.image?.byteLength).toBeGreaterThan(0);
  const ours = test.info().outputPath("ours.zip");
  writeFileSync(
    ours,
    buildDataArchive(
      {
        games: parsedGames.games,
        prizes: parsedPrizes.prizes,
        schedule: { date: parsedSchedule.date, items: parsedSchedule.items },
        settings: manifest.settings as never,
      },
      new Date().toISOString(),
    ),
  );

  // 設定と日付を戻してから取り込む（設定は選んだときだけ取り込む。日付も選ぶ）
  await admin.put("/admin/settings", DEFAULT_SETTINGS);
  await chooseFile(adm, { name: "ours.zip", mimeType: "application/zip", buffer: readFileSync(ours) });
  const dialog = adm.locator("dialog[open]");
  await expect(dialog.getByText("ゲーム（2 件）", { exact: true })).toBeVisible();
  await expect(dialog.getByText("景品（1 件）", { exact: true })).toBeVisible();
  await expect(dialog.getByText("スケジュール（1 件）", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("cell", { name: /（見せない）/ })).toBeVisible();
  await dialog.getByRole("checkbox", { name: "設定", exact: true }).check();
  await dialog.getByRole("checkbox", { name: new RegExp(`^イベントの日付も取り込む（${date}`) }).check();
  await dialog.getByRole("button", { name: "取り込む" }).click();
  await acceptConfirm(adm);
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
  await expect(adm.getByText("取り込みました。")).toBeVisible();

  // ゲームは下書きで追加され、同じ名前のラウンドが同じ順で作り直される
  /** 取り込んで作られた方（元のゲームでない方）。1 件だけのはず */
  const importedOf = async (name: string, original: string) => {
    const games = await gamesNamed(name);
    expect(games).toHaveLength(2);
    return games.find((g) => g.gameId !== original);
  };
  const importedQuiz = await importedOf(quizName, quiz.gameId);
  const importedNumber = await importedOf(numberName, number.gameId);
  expect(importedQuiz?.status).toBe("draft");
  expect(importedNumber?.correctNumber).toBe(42);
  const rounds = ((await admin.get("/admin/rounds")).rounds as Round[]).filter((r) => r.name === roundName);
  expect(rounds.map((r) => r.gameIds)).toContainEqual([importedQuiz!.gameId, importedNumber!.gameId]);
  // 景品は画像ごと、スケジュールは見せない列のまま追加される
  const importedPrizes = await prizesNamed(prizeName);
  expect(importedPrizes).toHaveLength(2);
  for (const p of importedPrizes) expect([p.imageId ? "image" : "none", p.positions]).toEqual(["image", [1]]);
  expect((await itemsTitled(itemTitle)).map((i) => i.hidden)).toEqual([true, true]);
  // 設定と日付も戻る
  const { settings } = await admin.get("/admin/settings");
  expect([settings.uploadPoints, settings.rankingVisible, settings.scheduleDate]).toEqual([7, true, date]);
});

test("P2 不正な ZIP は何も取り込まずに理由が出て、以前の形式（景品・ゲームの ZIP、スケジュールの JSON）は取り込める", async ({
  browser,
}) => {
  const { page: adm } = await adminPage(browser);
  await adm.goto("/admin/data");
  await expect(adm.getByRole("button", { name: "ファイルを選ぶ" })).toBeEnabled();
  const dialog = adm.locator("dialog[open]");
  const now = new Date().toISOString();

  // ZIP でないファイル・壊れた ZIP
  expect(await rejectedMessage(adm, { name: "memo.txt", mimeType: "text/plain", buffer: Buffer.from("hello") })).toBe(
    "このファイルは取り込めません。\nZIP ファイルではありません。エクスポートした ZIP を選んでください。",
  );
  expect(
    await rejectedMessage(adm, {
      name: "broken.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("PK\u0003\u0004 broken"),
    }),
  ).toMatch(/^このファイルは取り込めません。\n/);

  // 1 つでも問題があれば、ほかの正しいものも取り込まない（景品は正しいが、ゲームの名前が空）
  const validPrize = unique("E2E 取り込まれない景品");
  const partly = buildDataArchive(
    {
      prizes: [{ name: validPrize, quantity: 1, positions: [] }],
      games: [{ format: "quiz", name: "", description: "", choices: [], slots: [], ranks: [], voterPoints: 0 }],
    },
    now,
  );
  expect(
    await rejectedMessage(adm, { name: "partly.zip", mimeType: "application/zip", buffer: Buffer.from(partly) }),
  ).toMatch(/^このファイルは取り込めません。\nゲーム: /);
  await expect(dialog).toHaveCount(0);
  expect(await prizesNamed(validPrize)).toEqual([]);

  /** 以前の形式のファイルを取り込む（中身の種類だけが出る） */
  const importOld = async (file: { name: string; mimeType: string; buffer: Buffer }, section: string) => {
    await chooseFile(adm, file);
    await expect(dialog.getByText(section, { exact: true })).toBeVisible();
    await expect(dialog.locator("fieldset.data-import-section")).toHaveCount(1);
    await dialog.getByRole("button", { name: "取り込む" }).click();
    await expect(dialog).toHaveCount(0, { timeout: 60_000 });
    await expect(adm.getByText("取り込みました。")).toBeVisible();
  };

  const oldPrize = unique("E2E 以前の景品");
  await importOld(
    {
      name: "prizes.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(buildPrizeArchive([{ name: oldPrize, quantity: 2, positions: [3, 4] }], now)),
    },
    "景品（1 件）",
  );
  expect((await prizesNamed(oldPrize)).map((p) => p.positions)).toEqual([[3, 4]]);

  const oldGame = unique("E2E 以前のゲーム");
  await importOld(
    {
      name: "games.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(
        buildGameArchive(
          [
            {
              format: "keyword",
              name: oldGame,
              description: "",
              choices: [],
              slots: [],
              ranks: [{ from: 1, to: 1, points: 10 }],
              voterPoints: 0,
              keyword: "ひらけごま",
            },
          ],
          now,
        ),
      ),
    },
    "ゲーム（1 件）",
  );
  expect((await gamesNamed(oldGame)).map((g) => [g.format, g.status])).toEqual([["keyword", "draft"]]);

  const oldItem = unique("E2E 以前の項目");
  titles.push(oldItem);
  await importOld(
    {
      name: "schedule.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        buildScheduleFile(
          { items: [{ title: oldItem, detail: "", startMinute: 4 * 60 + 30, durationMinutes: 30 }] },
          now,
        ),
      ),
    },
    "スケジュール（1 件）",
  );
  expect(await itemsTitled(oldItem)).toHaveLength(1);
});

test("P2 スケジュールを取り込むと今の列と合わせて上限（50 列）を超えるときは、始める前に理由が出て取り込めない", async ({
  browser,
}) => {
  // 今の項目を少なくとも 1 列にする（右端の新しい列に置く）。ファイルは上限いっぱいの 50 列にするので、合わせると必ず超える
  const anchor = unique("E2E 列の上限 今の項目");
  titles.push(anchor);
  await admin.post("/admin/schedule", {
    title: anchor,
    detail: "",
    startMinute: 6 * 60,
    durationMinutes: 30,
    column: 49,
  });
  const fileItems: ScheduleFileItem[] = Array.from({ length: 50 }, (_, column) => {
    const title = unique(`E2E 列の上限 ${column}`);
    titles.push(title);
    return { title, detail: "", startMinute: 6 * 60, durationMinutes: 30, column };
  });

  const { page: adm } = await adminPage(browser);
  await adm.goto("/admin/data");
  await expect(adm.getByRole("button", { name: "ファイルを選ぶ" })).toBeEnabled();
  await chooseFile(adm, {
    name: "schedule.json",
    mimeType: "application/json",
    buffer: Buffer.from(buildScheduleFile({ items: fileItems }, new Date().toISOString())),
  });
  const dialog = adm.locator("dialog[open]");
  const reason = dialog.getByText(/取り込むと \d+ 列になって上限の 50 列を超えるため取り込めません/);
  await expect(reason).toBeVisible();
  await expect(dialog.getByRole("button", { name: "取り込む" })).toBeDisabled();
  // 置き換えも、取り込んでから今の項目を消すので同じ
  await dialog.getByLabel(/消して、取り込んだ項目に置き換える/).check();
  await expect(reason).toBeVisible();
  await expect(dialog.getByRole("button", { name: "取り込む" })).toBeDisabled();

  await dialog.getByRole("button", { name: "キャンセル" }).click();
  await expect(dialog).toHaveCount(0);
  // 1 件も作られていない
  const created = ((await admin.get("/admin/schedule")).items as Item[]).filter((i) =>
    fileItems.some((f) => f.title === i.title),
  );
  expect(created).toEqual([]);
});
