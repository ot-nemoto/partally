import type { Hono } from "hono";
import type { Env } from "../http.js";

/** これより大きい報告は読まずに捨てる（ログを埋められないように） */
const MAX_REPORT_BYTES = 8 * 1024;

/**
 * ブラウザが送る CSP の違反の報告（report-uri）を、伏せた要約にしてログ（CloudWatch Logs）に残す。
 * 報告は `application/csp-report` で届くので、「更新は JSON だけ」の確かめより前に登録する（状態は変えない）
 */
export function registerCspReportRoute(app: Hono<Env>) {
  app.post("/csp-report", async (c) => {
    const text = await c.req.text();
    if (text.length <= MAX_REPORT_BYTES) {
      const summary = summarizeCspReport(text);
      if (summary) console.warn(JSON.stringify({ cspViolation: summary }));
    }
    return c.body(null, 204);
  });
}

export interface CspViolationSummary {
  directive?: string;
  blocked?: string;
  page?: string;
  source?: string;
  line?: number;
}

/** 報告の本文から、違反した項目・読み込もうとしたもの（オリジンか種類）・ページのパスだけを取り出す。読めなければ undefined */
export function summarizeCspReport(text: string): CspViolationSummary | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null) return undefined;
  const report = ("csp-report" in body ? (body as Record<string, unknown>)["csp-report"] : body) as Record<
    string,
    unknown
  >;
  if (typeof report !== "object" || report === null) return undefined;
  const str = (key: string) => (typeof report[key] === "string" ? (report[key] as string) : undefined);
  const line = report["line-number"];
  return {
    directive: str("effective-directive") ?? str("violated-directive")?.split(" ")[0],
    blocked: maskBlocked(str("blocked-uri")),
    page: maskPath(str("document-uri")),
    source: maskPath(str("source-file")),
    line: typeof line === "number" ? line : undefined,
  };
}

/** 読み込もうとしたもの。URL ならオリジンだけ（パスやクエリの署名・トークンは残さない）、inline・eval・data などの種類はそのまま */
function maskBlocked(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : url.protocol.replace(/:$/, "");
  } catch {
    return value.slice(0, 40);
  }
}

/** ページ・スクリプトのパスだけを残す（オリジン・クエリは捨てる）。参加リンク（/q/<トークン>）のトークンは伏せる */
function maskPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let path: string;
  try {
    path = new URL(value).pathname;
  } catch {
    return undefined;
  }
  return path.replace(/^\/q\/[^/]+/, "/q/:token").slice(0, 200);
}
