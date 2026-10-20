import { describe, expect, it } from "vitest";
import { safeEqual, sign, verify } from "./session.js";

describe("session", () => {
  const secret = "s";

  it("署名したペイロードを検証できる", () => {
    const value = sign({ uid: "u1", iat: 100 }, secret);
    expect(verify(value, secret, 60, 150)).toEqual({ uid: "u1", iat: 100 });
  });

  it("期限切れ・別の鍵・改ざんは拒否する", () => {
    const value = sign({ uid: "u1", iat: 100 }, secret);
    expect(verify(value, secret, 60, 161)).toBeUndefined();
    expect(verify(value, "other", 60, 150)).toBeUndefined();

    const [, signature] = value.split(".");
    const forged = `${Buffer.from(JSON.stringify({ uid: "u2", iat: 100 })).toString("base64url")}.${signature}`;
    expect(verify(forged, secret, 60, 150)).toBeUndefined();
    expect(verify("garbage", secret, 60, 150)).toBeUndefined();
    expect(verify(undefined, secret, 60, 150)).toBeUndefined();
  });

  it("safeEqual は長さが違っても比較できる", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
