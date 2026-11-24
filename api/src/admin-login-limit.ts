import type { Context } from "hono";
import type { AdminLoginAttempt } from "./repository.js";

/**
 * 管理者のログインの試行回数の制限（パスワードの総当たりを防ぐ）。
 * 15 分ごとの区切りの中で、接続元ごと・全体の上限まで試せる。上限に達したら、その区切りが終わるまで断る。
 * 全体の上限は、接続元をたくさん使う攻撃でも、試せる回数の総数を抑えるためのもの。
 * 接続元（CloudFront-Viewer-Address）を偽って API Gateway に直接送ったものは、X-Origin-Verify が合わずに API が断る（app.ts）。
 * 断っている間は、区切りが終わるのを待つか、別の回線から入るか、Unlock admin login のワークフローで記録を消す
 */
export const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const ADMIN_LOGIN_MAX_PER_SOURCE = 10;
export const ADMIN_LOGIN_MAX_TOTAL = 50;
/** 記録は区切りが終わってからも少し残す（DynamoDB の TTL での削除は遅れることがあり、残っていても区切りが違えば数えない） */
const RECORD_TTL_MS = ADMIN_LOGIN_WINDOW_MS + 60 * 60 * 1000;

/** 今の区切りと、その終わり */
export function adminLoginWindow(now: Date): { window: string; endsAt: Date } {
  const start = Math.floor(now.getTime() / ADMIN_LOGIN_WINDOW_MS) * ADMIN_LOGIN_WINDOW_MS;
  return { window: new Date(start).toISOString(), endsAt: new Date(start + ADMIN_LOGIN_WINDOW_MS) };
}

export function adminLoginAttempt(window: string, source: string): AdminLoginAttempt {
  return {
    window,
    source,
    maxPerSource: ADMIN_LOGIN_MAX_PER_SOURCE,
    maxTotal: ADMIN_LOGIN_MAX_TOTAL,
    expiresAt: Math.floor((new Date(window).getTime() + RECORD_TTL_MS) / 1000),
  };
}

/**
 * 接続元（閲覧者の IP）。CloudFront が付ける CloudFront-Viewer-Address（`<IP>:<ポート>`。IPv6 は `<IPv6>:<ポート>`）から
 * ポートを外して使う。無いとき（ローカル開発・テスト）は API Gateway から見た接続元、それも無ければ "unknown"
 */
export function viewerAddress(c: Context): string {
  const header = c.req.header("cloudfront-viewer-address");
  if (header) {
    const colon = header.lastIndexOf(":");
    return colon > 0 ? header.slice(0, colon) : header;
  }
  const env = c.env as { requestContext?: { http?: { sourceIp?: string } } } | undefined;
  return env?.requestContext?.http?.sourceIp ?? "unknown";
}
