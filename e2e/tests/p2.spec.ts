import { expect, test } from "@playwright/test";
import { type AdminApi, adminApi } from "./helpers";

/**
 * P2: あると安心（docs/e2e-tests.md の 4 章）。
 * 準備のデータは API で作り、確かめたい流れだけを画面から操作する
 */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "admin";

test("P2 管理者ログインを続けて間違えると、正しいパスワードでも断られ、待つ時間と解除の方法が出る", async ({
  browser,
}) => {
  // 接続元ごとに数えるので、このテストだけの接続元にする（本番では CloudFront が付けるヘッダ。ローカルの API はそのまま使う）。
  // ほかのテストの管理者ログイン（ヘッダなし）は、この接続元の記録では断られない
  const source = `198.51.100.${Math.floor(Math.random() * 254) + 1}:${10000 + Math.floor(Math.random() * 50000)}`;
  const context = await browser.newContext({
    viewport: { width: 1200, height: 900 },
    locale: "ja-JP",
    extraHTTPHeaders: { "cloudfront-viewer-address": source },
  });
  const page = await context.newPage();
  await page.goto("/admin/login");

  // 接続元ごとの上限（10 回）まで間違える
  for (let i = 0; i < 10; i++) {
    await page.locator("input[type=password]").fill(`wrong-${i}`);
    await page.locator("button[type=submit]").click();
    await expect(page.locator(".error")).toHaveText("パスワードが違います。");
    // 同じ案内のままなので、送り終わる（ボタンが押せる）のを待ってから次を送る
    await expect(page.locator("button[type=submit]")).toBeEnabled();
  }

  // 正しいパスワードでも断られ、あと何分かと解除の方法が出る
  await page.locator("input[type=password]").fill(ADMIN_PASSWORD);
  await page.locator("button[type=submit]").click();
  await expect(page.locator(".error")).toHaveText(
    /パスワードを続けて間違えたため、しばらくログインできません（あと \d+ 分）。時間をおくか、別の回線から試すか、GitHub Actions の「Unlock admin login」で解除してください。/,
  );
  await expect(page).toHaveURL(/\/admin\/login$/);
  await context.close();

  // ほかの接続元からは、そのままログインできる
  const other: AdminApi = await adminApi();
  await other.dispose();
});
