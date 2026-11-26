import { formatMinute, localDate } from "@partally/shared";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  type AdminApi,
  acceptConfirm,
  adminApi,
  adminPage,
  deleteScheduleItems,
  participant,
  todayAt,
  unique,
  updateSettings,
  useDefaultSettings,
} from "./helpers";

/**
 * スケジュール（機能仕様書 9 章。#271）：管理画面のタイムラインの操作（作る・追加・削除・ドラッグ・列の表示）、プレビュー、
 * イベントの日付、参加者のスケジュールの表示（docs/e2e-tests.md の 3 章「公開・設定・移行・言語・景品・スケジュール」と 4 章）。
 * 準備の項目は API で作り、確かめたい流れだけを画面から操作する。
 *
 * - 参加者の画面の時刻は page.clock で決める（「いま」「つぎ」が流した時刻で変わらないように）
 * - スケジュールは 1 つの時間軸を共有するので、項目は列 49（いちばん右。作ると右端の新しい列になる）に置いて、
 *   ほかの項目と同じ列にしない。作った項目は、テストのたびに消す（deleteScheduleItems）
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

/** このテストで作った項目のタイトル（テストの終わりに消す） */
let titles: string[] = [];
test.afterEach(async ({ browser }) => {
  for (const context of browser.contexts()) await context.close();
  if (admin) await deleteScheduleItems(admin, titles);
  titles = [];
});

type Item = {
  itemId: string;
  title: string;
  detail: string;
  startMinute: number;
  durationMinutes: number;
  column: number;
  hidden: boolean;
};

/** 消す項目として覚えた、実行ごとに変わるタイトル */
function title(name: string): string {
  const t = unique(name);
  titles.push(t);
  return t;
}

/** 項目を作る（列を省くと列 49 = 右端の新しい列。長さを省くと 30 分） */
async function createItem(body: Partial<Item> & { title: string; startMinute: number }): Promise<Item> {
  const { item } = await admin.post("/admin/schedule", { detail: "", durationMinutes: 30, column: 49, ...body });
  return item;
}

const getItem = async (itemTitle: string): Promise<Item | undefined> =>
  ((await admin.get("/admin/schedule")).items as Item[]).find((i) => i.title === itemTitle);

async function mustGetItem(itemTitle: string): Promise<Item> {
  const item = await getItem(itemTitle);
  expect(item, `項目「${itemTitle}」が無い`).toBeDefined();
  return item!;
}

/** スケジュールの項目（参加者の画面・プレビュー・管理画面のタイムラインで共通の見た目） */
const block = (scope: Page | Locator, itemTitle: string) => scope.locator(".schedule-block", { hasText: itemTitle });
/** 管理画面のタイムラインの項目 */
const adminBlock = (page: Page, itemTitle: string) => block(page.locator(".schedule-grid"), itemTitle);
/** 項目に付いた「いま」「つぎ」 */
const badge = (b: Locator) => b.locator(".schedule-badge");

/** <input type="time"> の値（HH:MM） */
const timeValue = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/**
 * 管理画面のタイムラインで、target の真ん中（handle を渡すとその真ん中）をつかんで動かす。
 * x を渡すとその横の位置へ、dy を渡すとその分だけ縦に動かす
 */
async function drag(page: Page, target: Locator, to: { x?: number; dy?: number }) {
  await target.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  const toX = to.x ?? x;
  const toY = y + (to.dy ?? 0);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move((x + toX) / 2, (y + toY) / 2, { steps: 5 });
  await page.mouse.move(toX, toY, { steps: 5 });
  await page.mouse.up();
}

test.describe("管理画面のタイムライン", () => {
  test("P1 空いている所を押すと作れ、「項目を追加」で最後の項目の後ろに作れ、押して削除できる", async ({ browser }) => {
    const first = title("E2E 押して作る");
    const added = title("E2E 追加で作る");
    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/schedule");
    const grid = adm.locator(".schedule-grid");
    await expect(grid).toBeVisible();

    // 押した所の時刻・列に作る。時間軸は、ふつうはいちばん早い項目の 1 時間以上前から始まるが、0:00 より前には
    // 広がらないので、左端の列の上から、項目の無い所（押すと時間軸そのものに当たる所）を探して押す
    const startOf = async () => {
      const [h, m] = ((await adm.locator(".schedule-hour").first().textContent()) ?? "").split(":").map(Number);
      return h! * 60 + m!;
    };
    const rangeStart = await startOf();
    await grid.evaluate((el) => el.scrollIntoView({ block: "start" }));
    const box = await grid.boundingBox();
    const dy = await grid.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      for (let y = 10; rect.top + y < window.innerHeight && y < rect.height; y += 10) {
        if (document.elementFromPoint(rect.left + 5, rect.top + y) === el) return y;
      }
      return undefined;
    });
    expect(dy, "左端の列の、画面に見えている所に空きが無い").toBeDefined();
    await adm.mouse.click(box!.x + 5, box!.y + dy!);
    // 1 分 = 2px。押した時刻を 5 分刻みに切り捨てた時刻に作る
    const minute = Math.floor((rangeStart + dy! / 2) / 5) * 5;
    const dialog = adm.locator("dialog[open]");
    await expect(dialog.getByRole("heading", { name: "項目を追加" })).toBeVisible();
    await expect(dialog.getByLabel("開始", { exact: true })).toHaveValue(timeValue(minute));
    await dialog.getByLabel("タイトル", { exact: true }).fill(first);
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(adminBlock(adm, first)).toBeVisible();
    const created = await mustGetItem(first);
    expect([created.startMinute, created.durationMinutes]).toEqual([minute, 30]);

    // 「項目を追加」は、いちばん遅く終わる項目の後ろ（24:00 を越えるなら 23:30）に作る
    const items = (await admin.get("/admin/schedule")).items as Item[];
    const lastEnd = Math.max(...items.map((i) => i.startMinute + i.durationMinutes));
    const expected = Math.min(lastEnd, 24 * 60 - 30);
    await adm.getByRole("button", { name: "項目を追加", exact: true }).click();
    await expect(dialog.getByLabel("開始", { exact: true })).toHaveValue(timeValue(expected));
    await dialog.getByLabel("タイトル", { exact: true }).fill(added);
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(adminBlock(adm, added)).toBeVisible();
    expect((await mustGetItem(added)).startMinute).toBe(expected);

    // 項目を押すと編集が開き、削除できる
    await adminBlock(adm, first).click();
    await expect(dialog.getByRole("heading", { name: "項目の編集" })).toBeVisible();
    await dialog.getByRole("button", { name: "削除" }).click();
    await acceptConfirm(adm);
    await expect(dialog).toHaveCount(0);
    await expect(adminBlock(adm, first)).toHaveCount(0);
    expect(await getItem(first)).toBeUndefined();
  });

  test("P2 「前に／後ろに 1 時間広げる」で、時間軸が 1 時間ずつ広がる", async ({ browser }) => {
    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/schedule");
    const hours = adm.locator(".schedule-hour");
    await expect(hours.first()).toBeVisible();
    const before = await hours.allTextContents();

    // 時間軸が既に 0:00・24:00 まであれば、広げるボタンは押せない
    const earlier = adm.getByRole("button", { name: "↑ 前に 1 時間広げる" });
    const later = adm.getByRole("button", { name: "↓ 後ろに 1 時間広げる" });
    const first = before[0]!;
    const last = before.at(-1)!;
    if (first === formatMinute(0)) await expect(earlier).toBeDisabled();
    else {
      await earlier.click();
      const [h, m] = first.split(":").map(Number);
      await expect(hours.first()).toHaveText(formatMinute(h! * 60 + m! - 60));
    }
    if (last === formatMinute(24 * 60)) await expect(later).toBeDisabled();
    else {
      await later.click();
      const [h, m] = last.split(":").map(Number);
      await expect(hours.last()).toHaveText(formatMinute(h! * 60 + m! + 60));
    }
  });

  test("P1 上下のドラッグで開始時刻、下の端で長さ、左右で列が変わる", async ({ browser }) => {
    // 動かす項目と、左右で移す先の列の項目（どちらも右端の、ほかの項目の無い列に置く）。時刻は早朝にする
    const moving = title("E2E ドラッグ");
    const anchor = title("E2E 移す先");
    await createItem({ title: anchor, startMinute: 5 * 60 + 30 });
    await createItem({ title: moving, startMinute: 3 * 60, durationMinutes: 60 });
    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/schedule");
    const b = adminBlock(adm, moving);
    await expect(b).toBeVisible();

    // 上下：60px 下へ（1 分 = 2px）で 30 分遅くなる
    await drag(adm, b, { dy: 60 });
    await expect.poll(async () => (await mustGetItem(moving)).startMinute).toBe(3 * 60 + 30);
    expect((await mustGetItem(moving)).durationMinutes).toBe(60);

    // 下の端：40px 下へで 20 分長くなる
    await expect(b).toHaveAccessibleName(/^3:30〜4:30 /);
    await drag(adm, b.locator(".schedule-resize"), { dy: 40 });
    await expect.poll(async () => (await mustGetItem(moving)).durationMinutes).toBe(80);
    expect((await mustGetItem(moving)).startMinute).toBe(3 * 60 + 30);

    // 左右：移す先の項目の列の上で離すと、その列に入る（時間が重ならないので右へ移されない）。
    // ドラッグ中は右に空いた列を 1 つ足して見せるので、列の幅は時間軸の幅を（列の数 + 1）で割ったもの
    await expect(b).toHaveAccessibleName(/^3:30〜4:50 /);
    const items = (await admin.get("/admin/schedule")).items as Item[];
    const columns = Math.max(...items.map((i) => i.column)) + 1;
    const anchorColumn = (await mustGetItem(anchor)).column;
    const grid = await adm.locator(".schedule-grid").boundingBox();
    await drag(adm, b, { x: grid!.x + ((anchorColumn + 0.5) * grid!.width) / (columns + 1) });
    await expect.poll(async () => (await mustGetItem(moving)).column).toBe((await mustGetItem(anchor)).column);
    const moved = await mustGetItem(moving);
    expect([moved.startMinute, moved.durationMinutes]).toEqual([3 * 60 + 30, 80]);
  });

  test("P1 列を見せない設定にすると、その列の項目は参加者に出ず、「つぎ」は見せる項目だけで決まる", async ({
    browser,
  }) => {
    // 参加者の時刻は 2:17。見せない列にする項目が 2:18、見せる項目が 2:19 に始まる
    const now = 2 * 60 + 17;
    const hiding = title("E2E 見せない列");
    const showing = title("E2E 見せる列");
    const hidden = await createItem({ title: hiding, startMinute: now + 1 });
    await createItem({ title: showing, startMinute: now + 2 });
    await updateSettings(admin, { scheduleVisible: true });
    const a = await participant(browser, admin, "列 見る");
    await a.page.clock.setFixedTime(todayAt(now));
    await a.page.goto("/standings");
    await expect(badge(block(a.page, hiding))).toHaveText("つぎ");
    await expect(badge(block(a.page, showing))).toHaveCount(0);

    // 管理画面で、列の上のボタンで見せないようにする
    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/schedule");
    const toggle = adm.getByRole("button", { name: `列 ${hidden.column + 1} を参加者に見せる`, exact: true });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(toggle).toHaveText("見せない");
    await expect(adminBlock(adm, hiding)).toHaveAccessibleName(/（参加者に見せない）/);
    await expect.poll(async () => (await mustGetItem(hiding)).hidden).toBe(true);

    // 参加者には出ない（API からも返らない）。次の項目は、見せる項目だけで決まる
    const res = await a.page.request.get("/api/schedule");
    expect(((await res.json()).items as Item[]).map((i) => i.title)).not.toContain(hiding);
    await a.page.reload();
    await expect(block(a.page, showing)).toBeVisible();
    await expect(block(a.page, hiding)).toHaveCount(0);
    await expect(badge(block(a.page, showing))).toHaveText("つぎ");
  });

  test("P2 プレビューで時刻を選ぶと、その時刻の「いま」「つぎ」が出て、見せない列の件数が出る", async ({ browser }) => {
    const current = title("E2E プレビューの今");
    const next = title("E2E プレビューの次");
    const hiding = title("E2E プレビューの見せない");
    await createItem({ title: current, startMinute: 90 });
    await createItem({ title: next, startMinute: 120 });
    // 見せない項目は 1:40 に始まるが、「つぎ」には数えない
    await createItem({ title: hiding, startMinute: 100, hidden: true });
    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/schedule");
    await expect(adminBlock(adm, current)).toBeVisible();
    await adm.getByRole("button", { name: "プレビュー", exact: true }).click();
    const dialog = adm.locator("dialog[open]");
    await dialog.getByLabel("この時刻で見る").fill("01:35");
    await expect(badge(block(dialog, current))).toHaveText("いま");
    await expect(badge(block(dialog, next))).toHaveText("つぎ");
    await expect(block(dialog, hiding)).toHaveCount(0);
    await expect(dialog).toContainText(/参加者に見せない列の項目（\d+ 件）は出ません。/);
    // Setting で参加者に見せていない（既定値）ことも添える
    await expect(dialog).toContainText("今は Setting で参加者に見せない設定なので、参加者には見えません。");

    // 時刻を変えると付け直す
    await dialog.getByLabel("この時刻で見る").fill("02:05");
    await expect(badge(block(dialog, current))).toHaveCount(0);
    await expect(badge(block(dialog, next))).toHaveText("いま");
  });

  test("P1 イベントの日付を決めると、その日だけ「いま」「つぎ」が付く", async ({ browser }) => {
    const current = title("E2E 日付の今");
    await createItem({ title: current, startMinute: 40, durationMinutes: 40 });
    await updateSettings(admin, { scheduleVisible: true });
    const a = await participant(browser, admin, "日付 見る");
    const now = todayAt(60);
    await a.page.clock.setFixedTime(now);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // 管理画面で日付を明日にすると、今日は付かない（日付を出し、終わったとも扱わない）
    const { page: adm } = await adminPage(browser);
    await adm.goto("/admin/schedule");
    const date = adm.getByLabel("日付", { exact: true });
    await date.fill(localDate(tomorrow));
    await expect.poll(async () => (await admin.get("/admin/settings")).settings.scheduleDate).toBe(localDate(tomorrow));
    await a.page.goto("/standings");
    await expect(a.page.locator(".schedule-day")).toHaveText(
      new RegExp(`^${tomorrow.getMonth() + 1}月${tomorrow.getDate()}日（`),
    );
    await expect(block(a.page, current)).toBeVisible();
    await expect(badge(block(a.page, current))).toHaveCount(0);
    await expect(block(a.page, current)).not.toHaveClass(/\b(now|next|past)\b/);

    // 今日にすると付く
    await date.fill(localDate(now));
    await expect.poll(async () => (await admin.get("/admin/settings")).settings.scheduleDate).toBe(localDate(now));
    await a.page.reload();
    await expect(badge(block(a.page, current))).toHaveText("いま");
  });
});

test("P2 参加者のスケジュールは、横にスクロールでき、今の線までスクロールし、30 秒ごとに付け直し、終わった項目を薄くし、短い項目に「詳細あり」と出す", async ({
  browser,
}) => {
  // 参加者の時刻は 20:30:45。項目は列 49 に置くので、どれも別の列になる（4 列以上はスマホの幅に収まらない）
  const now = 20 * 60 + 30;
  const past = title("E2E 終わった");
  const current = title("E2E 今の");
  const soon = title("E2E 1 分後");
  const short = title("E2E 短い");
  await createItem({ title: past, startMinute: 8 * 60 });
  await createItem({ title: current, startMinute: 20 * 60, durationMinutes: 60 });
  await createItem({ title: soon, startMinute: now + 1 });
  // 30 分（48px）では詳細の 1 行が入らないので、詳細があることだけを出す
  await createItem({ title: short, startMinute: 21 * 60, detail: "持ち物はスマホだけです。" });
  await updateSettings(admin, { scheduleVisible: true });
  const a = await participant(browser, admin, "予定 見る");
  await a.page.clock.install({ time: todayAt(now, 45) });
  await a.page.goto("/standings");
  await expect(block(a.page, current)).toBeVisible();

  // 列が収まらないので、横にスクロールできる（画面全体は横にはみ出さない）
  const board = a.page.locator(".schedule-board");
  expect(await board.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await a.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // 今の時刻に線を引き、開いたときにそこまでスクロールする（8:00 からの時間軸なので、上からは見えない位置）
  const line = a.page.locator(".schedule-now-line");
  await expect(line).toHaveCount(1);
  expect(await a.page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const top = await line.evaluate((el) => el.getBoundingClientRect().top);
  expect(top).toBeGreaterThan(0);
  expect(top).toBeLessThan(a.page.viewportSize()!.height);

  // 終わった項目は薄くする
  await expect(block(a.page, past)).toHaveClass(/\bpast\b/);
  await expect(block(a.page, past)).toHaveCSS("opacity", "0.5");
  // 短い項目は、詳細の代わりに「詳細あり」と出す（押すと全文が出る）
  await expect(block(a.page, short)).toContainText("詳細あり");
  await block(a.page, short).click();
  await expect(a.page.locator("dialog[open]")).toContainText("持ち物はスマホだけです。");
  await a.page.locator("dialog[open]").getByRole("button", { name: "閉じる" }).click();

  // 30 秒たつと付け直す（20:31 を過ぎたので、「つぎ」だった項目が「いま」になる）
  await expect(badge(block(a.page, soon))).toHaveText("つぎ");
  await a.page.clock.fastForward(30_000);
  await expect(badge(block(a.page, soon))).toHaveText("いま");
});

test("P2 参加者のスケジュールの項目は、下のメニューの後ろを通り、メニューの上に重ならない", async ({ browser }) => {
  // 一日じゅうの項目にして、どこまでスクロールしても下のメニューの後ろに項目がある状態にする
  const allDay = title("E2E 一日じゅう");
  await createItem({ title: allDay, startMinute: 0, durationMinutes: 24 * 60 });
  await updateSettings(admin, { scheduleVisible: true });
  const a = await participant(browser, admin, "重なり 見る");
  await a.page.goto("/standings");
  const item = block(a.page, allDay);
  await expect(item).toBeVisible();
  await item.scrollIntoViewIfNeeded();

  // 項目の横の位置で、下のメニューの高さのところに描かれているのはメニュー（項目ではない）
  const nav = (await a.page.locator(".tabbar").boundingBox())!;
  const box = (await item.boundingBox())!;
  const x = Math.min(Math.max(box.x + box.width / 2, nav.x + 1), nav.x + nav.width - 1);
  const y = nav.y + nav.height / 2;
  // 測る点が、項目の中（メニューの後ろに項目がある所）であることを先に確かめる（項目が無い所で測っても確かめにならない）
  expect(x).toBeGreaterThan(box.x);
  expect(x).toBeLessThan(box.x + box.width);
  expect(y).toBeGreaterThan(box.y);
  expect(y).toBeLessThan(box.y + box.height);
  const onTop = await a.page.evaluate(
    ([px, py]) => document.elementFromPoint(px!, py!)?.closest(".tabbar") !== null,
    [x, y],
  );
  expect(onTop).toBe(true);
});
