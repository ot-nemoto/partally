import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildGameArchive, GAME_ARCHIVE_MAX_GAMES, type GameArchiveItem, readGameArchive } from "./game-archive.js";
import { buildPrizeArchive } from "./prize-archive.js";

const jpeg = (n: number) => new Uint8Array([0xff, 0xd8, n, 0xff, 0xd9]);
const base = { description: "", choices: [], slots: [], ranks: [], voterPoints: 0 };
const ranks = [
  { from: 1, to: 1, points: 10 },
  { from: 2, to: 3, points: 5 },
];
const games: GameArchiveItem[] = [
  {
    ...base,
    format: "quiz",
    name: "この人は誰?",
    description: "写真の人を当ててください",
    image: jpeg(1),
    choices: [
      { text: "A さん", points: 10, image: jpeg(2) },
      { text: "B さん", points: 0 },
    ],
  },
  { ...base, format: "result", name: "ビンゴ", slots: [{ name: "優勝", points: 30 }] },
  { ...base, format: "number", name: "身長は?", ranks, correctNumber: 72 },
  { ...base, format: "vote", name: "ベストドレッサー", ranks, voterPoints: 1 },
  { ...base, format: "keyword", name: "宝探し", ranks, keyword: "パーティー" },
  { ...base, format: "lottery", name: "抽選会", ranks: [{ from: 1, to: 3, points: 5 }] },
];
const manifest = (list: unknown[], extra: Record<string, unknown> = {}) =>
  strToU8(
    JSON.stringify({
      format: "partally-games",
      version: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      games: list,
      ...extra,
    }),
  );
const errorOf = (files: Record<string, Uint8Array>) => {
  const result = readGameArchive(zipSync(files));
  return result.ok ? undefined : result.error;
};

describe("ゲームの ZIP", () => {
  it("6 つの形式を書き出して読むと、同じゲームに戻る（画像は問題・選択肢の順に通し番号で入る）", () => {
    const zip = buildGameArchive(games, "2026-01-01T00:00:00.000Z");
    expect(Object.keys(unzipSync(zip)).sort()).toEqual(["games.json", "images/01.jpg", "images/02.jpg"]);
    expect(readGameArchive(zip)).toEqual({ ok: true, games });
  });

  it("状態・答え・枠に選んだ人は入れない（取り込むと下書きで、枠は空）", () => {
    const result = readGameArchive(
      zipSync({
        "games.json": manifest([
          {
            format: "result",
            name: "ビンゴ",
            status: "confirmed",
            slots: [{ name: "優勝", points: 30, userIds: ["U1"] }],
          },
        ]),
      }),
    );
    expect(result).toEqual({
      ok: true,
      games: [{ ...base, format: "result", name: "ビンゴ", slots: [{ name: "優勝", points: 30 }] }],
    });
  });

  it("1 つ上のフォルダに入っていても読める。省いた項目は既定の値になる", () => {
    const result = readGameArchive(
      zipSync({
        "ゲーム/games.json": manifest([
          {
            format: "quiz",
            name: "Q",
            image: "images/q.png",
            choices: [
              { text: "あ", points: 1 },
              { text: "い", points: 0 },
            ],
          },
        ]),
        "ゲーム/images/q.png": jpeg(9),
        "__MACOSX/ゲーム/._games.json": strToU8("x"),
      }),
    );
    expect(result).toEqual({
      ok: true,
      games: [
        {
          ...base,
          format: "quiz",
          name: "Q",
          image: jpeg(9),
          choices: [
            { text: "あ", points: 1 },
            { text: "い", points: 0 },
          ],
        },
      ],
    });
  });

  it("形の違うファイルや、作成の決まりに合わないゲームは、理由を出して何も取り込まない", () => {
    expect(readGameArchive(strToU8("zip ではない"))).toMatchObject({ ok: false });
    expect(errorOf({ "a.txt": strToU8("x") })).toContain("games.json がありません");
    // 景品の ZIP を取り違えた
    expect(readGameArchive(buildPrizeArchive([{ name: "x", quantity: 1, positions: [] }], "t"))).toMatchObject({
      ok: false,
      error: expect.stringContaining("games.json がありません"),
    });
    expect(errorOf({ "games.json": manifest([], { format: "partally-prizes" }) })).toContain(
      "ゲームのエクスポートの形ではありません",
    );
    expect(errorOf({ "games.json": manifest([], { version: 2 }) })).toContain("対応していない版");
    expect(errorOf({ "games.json": manifest([]) })).toContain("1 つも入っていません");
    const many = Array.from({ length: GAME_ARCHIVE_MAX_GAMES + 1 }, () => ({ format: "result", name: "x" }));
    expect(errorOf({ "games.json": manifest(many) })).toContain("多すぎます");
    // クイズの選択肢が 1 つ、知らない形式、合言葉が無い、範囲が重なる
    expect(
      errorOf({ "games.json": manifest([{ format: "quiz", name: "Q", choices: [{ text: "a", points: 1 }] }]) }),
    ).toContain("1 件目（Q）: choices");
    expect(errorOf({ "games.json": manifest([{ format: "bingo", name: "B" }]) })).toContain("format");
    expect(errorOf({ "games.json": manifest([{ format: "keyword", name: "K" }]) })).toContain("keyword");
    expect(
      errorOf({
        "games.json": manifest([
          {
            format: "number",
            name: "N",
            ranks: [
              { from: 1, to: 3, points: 1 },
              { from: 2, to: 4, points: 1 },
            ],
          },
        ]),
      }),
    ).toContain("重なっています");
    expect(errorOf({ "games.json": manifest([{ format: "result", name: "R" }, "x"]) })).toContain("2 件目: ゲームの形");
    expect(errorOf({ "games.json": manifest([{ format: "result", name: "R", slots: "x" }]) })).toContain("枠の形");
    // 画像が無い・パスが正しくない
    expect(errorOf({ "games.json": manifest([{ format: "result", name: "R", image: "images/x.jpg" }]) })).toContain(
      "問題の画像 images/x.jpg が ZIP の中にありません",
    );
    expect(
      errorOf({
        "games.json": manifest([
          {
            format: "quiz",
            name: "Q",
            choices: [
              { text: "a", points: 1 },
              { text: "b", points: 0, image: 3 },
            ],
          },
        ]),
      }),
    ).toContain("選択肢 2 の画像のパスが正しくありません");
  });
});
