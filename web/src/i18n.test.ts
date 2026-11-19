import { describe, expect, it } from "vitest";
import { getLang, initialLang, people, pts, setLang, tr } from "./i18n";

describe("画面の言語", () => {
  it("覚えた言語があればそれ、無ければブラウザの言語（日本語以外は英語）", () => {
    expect(initialLang("en", ["ja-JP"])).toBe("en");
    expect(initialLang("ja", ["en-US"])).toBe("ja");
    expect(initialLang(null, ["ja-JP", "en-US"])).toBe("ja");
    expect(initialLang(null, ["JA"])).toBe("ja");
    expect(initialLang(null, ["en-US", "ja-JP"])).toBe("en");
    expect(initialLang(null, ["zh-TW"])).toBe("en");
    expect(initialLang("fr", ["ja"])).toBe("ja");
    // 言語が分からなければ日本語
    expect(initialLang(null, [])).toBe("ja");
  });

  it("切り替えると、文言の選び方も変わる", () => {
    setLang("en");
    expect(getLang()).toBe("en");
    expect(tr("日本語", "English")).toBe("English");
    setLang("ja");
    expect(tr("日本語", "English")).toBe("日本語");
  });

  it("英語の点数と人数は単数・複数を分ける", () => {
    expect(pts(1)).toBe("1 pt");
    expect(pts(0)).toBe("0 pts");
    expect(people(1)).toBe("1 person");
    expect(people(3)).toBe("3 people");
  });
});
