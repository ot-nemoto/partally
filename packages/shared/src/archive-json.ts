/** エクスポート・インポートの一覧の JSON を確かめる部品（ZIP のライブラリを使わないので、API・画面のどちらでも読み込める） */

/** 取り込める ZIP の大きさ（画面は、ファイルを読む前にこれで確かめる） */
export const ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 一覧の JSON の中の画像のパス。無ければ undefined、形が正しくなければ false */
export function imagePathOf(value: unknown): string | undefined | false {
  if (value === undefined || value === null || value === "") return undefined;
  return typeof value === "string" ? value : false;
}

/** zod の最初の誤りを「choices.0.text が正しくありません（…）。」の形にする */
export function issueText(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  const issue = issues[0];
  return `${issue?.path.map(String).join(".") || "内容"} が正しくありません（${issue?.message ?? ""}）。`;
}
