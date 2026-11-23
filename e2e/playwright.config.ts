import { defineConfig } from "@playwright/test";

/**
 * E2E テスト（docs/e2e-tests.md の一覧）。ローカル開発環境（メモリ内の API と web）に対して実行し、本番 AWS には流さない。
 * API は 1 つで、データはテストの間で共有されるので、1 つずつ順に実行する（各テストは自分で作ったデータだけを見る）
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:5173",
    locale: "ja-JP",
    trace: "off",
  },
  // テストを始める前に、API と web を起動する（ローカルで起動済みなら使い回す）
  webServer: [
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
  ],
});
