import { describe, expect, it } from "vitest";
import { initialShown } from "./StatusFilter";

const ALL = ["a", "b", "c"] as const;

describe("一覧に出すものの初めの状態", () => {
  it("覚えたものが無ければ initial、省けば全部", () => {
    expect([...initialShown(null, ALL, [])]).toEqual([]);
    expect([...initialShown(null, ALL, ["b"])]).toEqual(["b"]);
    expect([...initialShown(null, ALL)]).toEqual(["a", "b", "c"]);
  });

  it("覚えたものがあればそれ（知らないものは除き、並びは元のまま）", () => {
    expect([...initialShown('["c","a","x"]', ALL, [])]).toEqual(["a", "c"]);
    expect([...initialShown("[]", ALL)]).toEqual([]);
  });

  it("壊れている・配列でないときは初めの状態", () => {
    expect([...initialShown("{", ALL, [])]).toEqual([]);
    expect([...initialShown('{"a":1}', ALL)]).toEqual(["a", "b", "c"]);
  });
});
