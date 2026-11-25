import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildDataArchive, type DataArchive, readDataArchive, type SettingsArchive } from "./data-archive.js";
import { buildGameArchive, type GameArchiveItem } from "./game-archive.js";
import { buildPrizeArchive } from "./prize-archive.js";
import { buildScheduleFile } from "./schedule-file.js";
import { TIE_BREAK_KEYS } from "./schemas.js";

const jpeg = (n: number) => new Uint8Array([0xff, 0xd8, n, 0xff, 0xd9]);
const game = (g: Partial<GameArchiveItem> & Pick<GameArchiveItem, "format" | "name">): GameArchiveItem => ({
  description: "",
  choices: [],
  slots: [],
  ranks: [],
  voterPoints: 0,
  ...g,
});
const settings: SettingsArchive = {
  moderation: "post",
  uploadPoints: 7,
  favoritesEnabled: true,
  favoriteLimit: 10,
  favoritePoints: 1,
  favoriteGivenPoints: 10,
  showPoints: true,
  showGamePoints: false,
  rankingVisible: true,
  rankingHideNames: false,
  rankingHidePoints: true,
  trendVisible: false,
  trendHideNames: false,
  trendHidePoints: false,
  prizesVisible: true,
  tieBreakOrder: [...TIE_BREAK_KEYS].reverse(),
  scheduleVisible: true,
};
const all: DataArchive = {
  prizes: [
    { name: "テレビ", quantity: 1, positions: [1], image: jpeg(1) },
    { name: "お菓子", quantity: 3, positions: [5, 8, 10] },
  ],
  games: [
    game({
      format: "quiz",
      name: "この人は誰?",
      image: jpeg(2),
      choices: [
        { text: "A", points: 10, image: jpeg(3) },
        { text: "B", points: 0 },
      ],
    }),
    game({ format: "result", name: "ビンゴ", slots: [{ name: "優勝", points: 30 }] }),
  ],
  schedule: {
    date: "2026-12-24",
    items: [
      { title: "開場", detail: "受付は 1 階", startMinute: 1080, durationMinutes: 30 },
      { title: "乾杯", detail: "", startMinute: 1110, durationMinutes: 5, column: 1, hidden: true },
    ],
  },
  settings,
};
const zipOf = (data: Record<string, unknown>) =>
  zipSync({
    "data.json": strToU8(
      JSON.stringify({ format: "partally-data", version: 1, exportedAt: "2026-01-01T00:00:00.000Z", ...data }),
    ),
  });
const errorOf = (bytes: Uint8Array) => {
  const result = readDataArchive(bytes);
  return result.ok ? undefined : result.error;
};

describe("まとめた ZIP（Data タブ）", () => {
  it("ゲーム・景品・スケジュール・設定を書き出して読むと元に戻る（画像はゲーム・景品の順に通し番号）", () => {
    const zip = buildDataArchive(all, "2026-01-01T00:00:00.000Z");
    expect(Object.keys(unzipSync(zip)).sort()).toEqual([
      "data.json",
      "images/01.jpg",
      "images/02.jpg",
      "images/03.jpg",
    ]);
    expect(readDataArchive(zip)).toEqual({ ok: true, data: all });
  });

  it("選んだ種類だけを書き出せ、入っている種類だけが読める", () => {
    const zip = buildDataArchive({ schedule: all.schedule, settings }, "t");
    expect(Object.keys(unzipSync(zip))).toEqual(["data.json"]);
    expect(readDataArchive(zip)).toEqual({ ok: true, data: { schedule: all.schedule, settings } });
  });

  it("件数に上限は無く、多い環境で書き出したものもそのまま読める（以前の 100 件・200 件の上限を超える数で確かめる）", () => {
    const many: DataArchive = {
      games: Array.from({ length: 150 }, (_, i) =>
        game({ format: "result", name: `ゲーム ${i + 1}`, slots: [{ name: "優勝", points: 10 }] }),
      ),
      prizes: Array.from({ length: 150 }, (_, i) => ({ name: `景品 ${i + 1}`, quantity: 1, positions: [] })),
      // 読むと始まる時刻・列の順に並ぶので、その順で作る（7 列に 30 分ずつ）
      schedule: {
        date: "2026-12-24",
        items: Array.from({ length: 250 }, (_, i) => ({
          title: `項目 ${i + 1}`,
          detail: "",
          startMinute: Math.floor(i / 7) * 30,
          durationMinutes: 30,
          column: i % 7,
        })),
      },
    };
    expect(readDataArchive(buildDataArchive(many, "t"))).toEqual({ ok: true, data: many });
    // 以前の景品・ゲームの ZIP と、スケジュールの JSON も同じ
    expect(readDataArchive(buildGameArchive(many.games!, "t"))).toEqual({ ok: true, data: { games: many.games } });
    expect(readDataArchive(buildPrizeArchive(many.prizes!, "t"))).toEqual({ ok: true, data: { prizes: many.prizes } });
    expect(readDataArchive(strToU8(buildScheduleFile(many.schedule!, "t")))).toEqual({
      ok: true,
      data: { schedule: many.schedule },
    });
  });

  it("以前の景品・ゲームの ZIP と、スケジュールの JSON も読める", () => {
    expect(readDataArchive(buildPrizeArchive(all.prizes!, "t"))).toEqual({ ok: true, data: { prizes: all.prizes } });
    expect(readDataArchive(buildGameArchive(all.games!, "t"))).toEqual({ ok: true, data: { games: all.games } });
    expect(readDataArchive(strToU8(buildScheduleFile(all.schedule!, "t")))).toEqual({
      ok: true,
      data: { schedule: all.schedule },
    });
  });

  it("設定のイベントの日付は取り込まない（スケジュールの側で扱う）。知らない項目は読まない", () => {
    const result = readDataArchive(zipOf({ settings: { ...settings, scheduleDate: "2027-01-01", unknown: 1 } }));
    expect(result).toEqual({ ok: true, data: { settings } });
  });

  it("形の違うファイルや、決まりに合わない中身は、種類と理由を出して何も取り込まない", () => {
    expect(errorOf(strToU8("こんにちは"))).toContain("ZIP ファイルではありません");
    expect(errorOf(strToU8(`{"format": "partally-schedule", "pad": "${"x".repeat(1024 * 1024)}"}`))).toContain(
      "ファイルが大きすぎます（スケジュールの JSON は 1MB まで）",
    );
    expect(errorOf(strToU8('{"format": "x"}'))).toContain("スケジュールのエクスポートの形ではありません");
    expect(errorOf(zipSync({ "a.txt": strToU8("x") }))).toContain("data.json・prizes.json・games.json がありません");
    expect(errorOf(zipOf({ format: "partally-prizes" }))).toContain("エクスポートの形ではありません");
    expect(errorOf(zipOf({ version: 2 }))).toContain("対応していない版");
    expect(errorOf(zipOf({}))).toContain("どれも入っていません");
    expect(errorOf(zipOf({ prizes: "x" }))).toContain("景品: 一覧");
    expect(errorOf(zipOf({ prizes: [{ name: "A", quantity: 1, positions: [1, 2] }] }))).toContain("景品: 1 件目");
    expect(errorOf(zipOf({ games: [{ format: "quiz", name: "Q" }] }))).toContain("ゲーム: 1 件目（Q）");
    expect(errorOf(zipOf({ games: [{ format: "result", name: "R", image: "images/x.jpg" }] }))).toContain(
      "ゲーム: 1 件目: 問題の画像 images/x.jpg が ZIP の中にありません",
    );
    expect(errorOf(zipOf({ schedule: { items: [] } }))).toContain("スケジュール: 項目が 1 つも入っていません");
    expect(errorOf(zipOf({ settings: { ...settings, moderation: "x" } }))).toContain("設定: moderation");
    expect(errorOf(zipOf({ settings: { uploadPoints: 1 } }))).toContain("設定:");
  });
});
