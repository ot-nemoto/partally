import { defineConfig } from "@playwright/test";

/**
 * E2E テスト（docs/e2e-tests.md の一覧）。ふだんはローカル開発環境（メモリ内の API と web）に対して実行する。
 * E2E_BASE_URL を付けると、その URL の環境（データの入った検証用の環境など）に対して実行し、ローカルのサーバは起動しない
 * （流し方と注意は docs/e2e-tests.md）。
 * API は 1 つで、データはテストの間で共有されるので、1 つずつ順に実行する（各テストは自分で作ったデータだけを見る）
 */
const remoteUrl = process.env.E2E_BASE_URL?.replace(/\/+$/, "") || undefined;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: remoteUrl ?? "http://localhost:5173",
    locale: "ja-JP",
    trace: "off",
    // 入っているブラウザを使うとき（Playwright の版に合うブラウザを入れられない環境など）は、その場所を
    // PLAYWRIGHT_CHROMIUM_PATH に入れる。無ければ Playwright が入れたブラウザを使う（CI はこちら）
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH && {
      launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH },
    }),
  },
  // テストを始める前に、API と web を起動する（ローカルで起動済みなら使い回す）。ほかの環境へ向けるときは起動しない
  webServer: remoteUrl
    ? undefined
    : [
        {
          command: "npx tsx ../api/src/dev.ts",
          url: "http://localhost:8787/api/admin/me",
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
        {
          command: "npm run dev -w web -- --strictPort",
          cwd: "..",
          url: "http://localhost:5173",
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
        // 本番と同じビルドの画面（CSP を効かせるテスト csp.spec.ts で使う。開発用のサーバはインラインのスクリプトを入れるため）。
        // 古いビルドで確かめないよう、使い回さずに毎回ビルドし直す
        {
          command: "npm run build -w web && npm run preview -w web -- --port 4173 --strictPort",
          cwd: "..",
          url: "http://localhost:4173",
          reuseExistingServer: false,
          timeout: 120_000,
        },
      ],
});
