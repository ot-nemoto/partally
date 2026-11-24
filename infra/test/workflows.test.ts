import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** .github の中のワークフローと、このリポジトリのアクション */
const files = [
  ...readdirSync(new URL("../../.github/workflows/", import.meta.url)).map((f) => `workflows/${f}`),
  ...readdirSync(new URL("../../.github/actions/", import.meta.url)).map((d) => `actions/${d}/action.yml`),
];

const usesOf = (file: string) =>
  [
    ...readFileSync(new URL(`../../.github/${file}`, import.meta.url), "utf8").matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm),
  ].map((m) => m[1]!);

describe("ワークフローで使うアクション", () => {
  it("GitHub 以外が作るアクションは、コミットの SHA（40 桁）で固定する", () => {
    const external = files.flatMap((file) =>
      usesOf(file)
        .filter((uses) => !uses.startsWith("./") && !uses.startsWith("actions/"))
        .map((uses) => ({ file, uses })),
    );
    expect(external.length).toBeGreaterThan(0);
    for (const { file, uses } of external) {
      expect(uses, `${file}: ${uses}`).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});
