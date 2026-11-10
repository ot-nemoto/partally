import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  buildPrizeArchive,
  PRIZE_ARCHIVE_MAX_FILE_BYTES,
  PRIZE_ARCHIVE_MAX_PRIZES,
  readPrizeArchive,
} from "./prize-archive.js";

const jpeg = (n: number) => new Uint8Array([0xff, 0xd8, n, 0xff, 0xd9]);
const manifest = (prizes: unknown[], extra: Record<string, unknown> = {}) =>
  strToU8(
    JSON.stringify({ format: "partally-prizes", version: 1, exportedAt: "2026-01-01T00:00:00.000Z", prizes, ...extra }),
  );
const errorOf = (files: Record<string, Uint8Array>) => {
  const result = readPrizeArchive(zipSync(files));
  return result.ok ? undefined : result.error;
};

describe("景品の ZIP", () => {
  it("書き出した ZIP を読むと同じ景品に戻る（画像の無い景品もある）", () => {
    const prizes = [
      { name: "テレビ", quantity: 1, positions: [1], image: jpeg(1) },
      { name: "お菓子", quantity: 3, positions: [5, 8, 10] },
      { name: "商品券", quantity: 2, positions: [], image: jpeg(2) },
    ];
    const zip = buildPrizeArchive(prizes, "2026-01-01T00:00:00.000Z");
    expect(Object.keys(unzipSync(zip)).sort()).toEqual(["images/01.jpg", "images/03.jpg", "prizes.json"]);
    const result = readPrizeArchive(zip);
    expect(result).toEqual({ ok: true, prizes });
  });

  it("1 つ上のフォルダに入っていても読める。macOS の付属ファイルは読まない", () => {
    const result = readPrizeArchive(
      zipSync({
        "景品/prizes.json": manifest([{ name: "テレビ", quantity: 1, positions: [1], image: "images/a.png" }]),
        "景品/images/a.png": jpeg(1),
        "__MACOSX/景品/._prizes.json": strToU8("x"),
      }),
    );
    expect(result).toEqual({ ok: true, prizes: [{ name: "テレビ", quantity: 1, positions: [1], image: jpeg(1) }] });
  });

  it("名前は前後の空白を除き、順位は小さい順にそろえる", () => {
    const result = readPrizeArchive(
      zipSync({ "prizes.json": manifest([{ name: " テレビ ", quantity: 3, positions: [3, 1] }]) }),
    );
    expect(result).toEqual({ ok: true, prizes: [{ name: "テレビ", quantity: 3, positions: [1, 3] }] });
  });

  it("取り込めないときは理由を返す", () => {
    expect(readPrizeArchive(strToU8("not a zip"))).toEqual({
      ok: false,
      error: expect.stringContaining("ZIP ファイルを読めません"),
    });
    expect(errorOf({ "other.json": strToU8("{}") })).toContain("prizes.json がありません");
    expect(errorOf({ "prizes.json": strToU8("{") })).toContain("JSON の形になっていません");
    expect(errorOf({ "prizes.json": strToU8(JSON.stringify({ prizes: [] })) })).toContain(
      "景品のエクスポートの形ではありません",
    );
    expect(errorOf({ "prizes.json": manifest([], { version: 2 }) })).toContain("対応していない版");
    expect(errorOf({ "prizes.json": manifest([]) })).toContain("1 つも入っていません");
    const many = Array.from({ length: PRIZE_ARCHIVE_MAX_PRIZES + 1 }, () => ({
      name: "a",
      quantity: 1,
      positions: [],
    }));
    expect(errorOf({ "prizes.json": manifest(many) })).toContain("多すぎます");
    expect(errorOf({ "prizes.json": manifest([{ name: "", quantity: 1, positions: [] }]) })).toContain("1 件目: name");
    // 数量より多い順位
    expect(errorOf({ "prizes.json": manifest([{ name: "a", quantity: 1, positions: [1, 2] }]) })).toContain(
      "1 件目: positions",
    );
    expect(
      errorOf({ "prizes.json": manifest([{ name: "a", quantity: 1, positions: [], image: "images/x.jpg" }]) }),
    ).toContain("images/x.jpg が ZIP の中にありません");
    expect(errorOf({ "prizes.json": manifest([{ name: "a", quantity: 1, positions: [], image: 1 }]) })).toContain(
      "画像のパスが正しくありません",
    );
  });

  it("展開後に大きすぎるファイルは読まない", () => {
    const big = new Uint8Array(PRIZE_ARCHIVE_MAX_FILE_BYTES + 1);
    expect(
      errorOf({ "prizes.json": manifest([{ name: "a", quantity: 1, positions: [] }]), "images/big.jpg": big }),
    ).toContain("大きすぎます");
  });
});
