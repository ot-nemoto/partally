import { afterEach, describe, expect, it, vi } from "vitest";
import { summarizeCspReport } from "./routes/csp-report.js";
import { useApiTest } from "./test-support.js";

describe("CSP の違反の報告（POST /api/csp-report）", () => {
  const t = useApiTest();
  afterEach(() => vi.restoreAllMocks());

  const report = {
    "csp-report": {
      "document-uri": "https://example.test/q/AbCdEfGhIjKlMnOpQrStUv?x=1",
      "violated-directive": "script-src-elem",
      "effective-directive": "script-src-elem",
      "blocked-uri": "https://evil.example/x.js?token=secret",
      "source-file": "https://example.test/assets/index-abc.js",
      "line-number": 12,
    },
  };

  it("application/csp-report の報告を受けて 204 を返し、伏せた要約をログに出す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await t.app.request("/api/csp-report", {
      method: "POST",
      headers: { "content-type": "application/csp-report" },
      body: JSON.stringify(report),
    });
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warn.mock.calls[0]![0] as string)).toEqual({
      cspViolation: {
        directive: "script-src-elem",
        blocked: "https://evil.example",
        page: "/q/:token",
        source: "/assets/index-abc.js",
        line: 12,
      },
    });
  });

  it("大きすぎる・形の違う報告は、ログに出さずに 204 を返す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const body of ["x".repeat(9000), "not json", "null", "[1]"]) {
      const res = await t.app.request("/api/csp-report", {
        method: "POST",
        headers: { "content-type": "application/csp-report" },
        body,
      });
      expect(res.status).toBe(204);
    }
    expect(warn.mock.calls.filter(([m]) => String(m).includes('"directive"'))).toHaveLength(0);
  });

  it("inline・eval などの種類は種類のまま、data: などはスキームだけを残す", () => {
    const summarize = (blocked: string) =>
      summarizeCspReport(
        JSON.stringify({ "csp-report": { "blocked-uri": blocked, "violated-directive": "img-src 'self'" } }),
      );
    expect(summarize("inline")).toMatchObject({ blocked: "inline", directive: "img-src" });
    expect(summarize("eval")?.blocked).toBe("eval");
    expect(summarize("data:image/png;base64,AAAA")?.blocked).toBe("data");
    expect(summarize("blob:https://example.test/1234")?.blocked).toBe("blob");
  });
});
