import { describe, expect, it, vi } from "vitest";
import { cachedValue } from "./cached-value.js";

describe("cachedValue", () => {
  it("決めた間は読み直さず、過ぎたら読み直して新しい値を返す", async () => {
    let now = 0;
    let stored = "a";
    const load = vi.fn(async () => stored);
    const get = cachedValue(load, 1000, () => now);
    expect(await get()).toBe("a");
    stored = "b";
    now = 999;
    expect(await get()).toBe("a");
    expect(load).toHaveBeenCalledTimes(1);
    now = 1000;
    expect(await get()).toBe("b");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("最初の読み込みの失敗はそのまま投げ、次の呼び出しで読み直す", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue("a");
    const get = cachedValue(load, 1000, () => 0);
    await expect(get()).rejects.toThrow("down");
    expect(await get()).toBe("a");
  });

  it("読み直しに失敗したら前の値を返し、次はまた決めた間が過ぎてから読み直す", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let now = 0;
    const load = vi.fn().mockResolvedValueOnce("a").mockRejectedValueOnce(new Error("down")).mockResolvedValue("b");
    const get = cachedValue(load, 1000, () => now);
    expect(await get()).toBe("a");
    now = 1000;
    expect(await get()).toBe("a");
    now = 1999;
    expect(await get()).toBe("a");
    expect(load).toHaveBeenCalledTimes(2);
    now = 2000;
    expect(await get()).toBe("b");
  });
});
