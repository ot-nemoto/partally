import { expect, test } from "@playwright/test";
import { ADMIN_LOGIN_WINDOW_MS } from "../../api/src/admin-login-limit.js";
import { type AdminApi, adminApi } from "./helpers";

/**
 * P2: あると安心（docs/e2e-tests.md の 4 章）。
 * 準備のデータは API で作り、確かめたい流れだけを画面から操作する
 */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "admin";

test("P2 管理者ログインを続けて間違えると、正しいパスワードでも断られ、待つ時間と解除の方法が出る", async ({
  browser,
}) => {
  // 区切りが途中で変わると数え直しになるので、区切りの終わりが近ければ次の区切りまで待つ
  const left = ADMIN_LOGIN_WINDOW_MS - (Date.now() % ADMIN_LOGIN_WINDOW_MS);
  if (left < 30_000) {
    test.setTimeout(60_000 + left);
    await new Promise((resolve) => setTimeout(resolve, left + 1_000));
  }

  // 接続元ごとに数えるので、このテストだけの接続元にする（本番では CloudFront が付けるヘッダ。ローカルの API はそのまま使う）。
  // API はポートを外して IP で数えるので、IP を毎回変える（IPv6 の文書用の範囲に、時刻と乱数を入れる）。
  // ほかのテストの管理者ログイン（ヘッダなし）は、この接続元の記録では断られない
  const id = `${Date.now().toString(16)}${Math.floor(Math.random() * 0xffff).toString(16)}`;
  const source = `2001:db8::${id.slice(-12, -8) || "0"}:${id.slice(-8, -4)}:${id.slice(-4)}:443`;
  const context = await browser.newContext({
    viewport: { width: 1200, height: 900 },
    locale: "ja-JP",
    extraHTTPHeaders: { "cloudfront-viewer-address": source },
  });
  let other: AdminApi | undefined;
  try {
    const page = await context.newPage();
    await page.goto("/admin/login");
    const login = async (password: string) => {
      await page.locator("input[type=password]").fill(password);
      const response = page.waitForResponse("**/api/admin/login");
      await page.locator("button[type=submit]").click();
      return (await response).status();
    };

    // 接続元ごとの上限（10 回）まで間違える（1 回ずつ、応答が返ってから次を送る）
    for (let i = 0; i < 10; i++) {
      expect(await login(`wrong-${i}`)).toBe(401);
      await expect(page.locator(".error")).toHaveText("パスワードが違います。");
    }

    // 正しいパスワードでも断られ、あと何分かと解除の方法が出る
    expect(await login(ADMIN_PASSWORD)).toBe(429);
    await expect(page.locator(".error")).toHaveText(
      /パスワードを続けて間違えたため、しばらくログインできません（あと \d+ 分）。時間をおくか、別の回線から試すか、GitHub Actions の「Unlock admin login」で解除してください。/,
    );
    await expect(page).toHaveURL(/\/admin\/login$/);

    // ほかの接続元からは、そのままログインできる
    other = await adminApi();
  } finally {
    await context.close();
    await other?.dispose();
  }
});
