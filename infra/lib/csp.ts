/**
 * 読み込み元を絞る CSP。CloudFront の応答の Content-Security-Policy として付ける（#227。初めは Report-Only で試し、
 * E2E で主な流れ（Chromium と WebKit）が違反なく動くことを確かめてから強制に移した）。違反は report-uri でログに残る。
 * E2E（e2e/tests/csp.spec.ts）でも、この値を効かせて画面を動かす。そのため CDK に頼らないファイルに置く。
 * - script-src 'unsafe-eval' と worker-src blob:（と child-src blob:）は、HEIC の変換（heic2any）が blob: の URL から Worker を作り、その中で new Function を使うため。
 *   なお 'unsafe-eval' を外すと、入力の検証（zod）が eval を使えるかを試すところでも違反が報告される（使えなければ使わずに動くので、画面は壊れない）
 * - child-src 'self' blob: は、worker-src を知らない古い Safari（iOS 15.4 以前）が Worker の許可を child-src で決めるため
 *   （無いと default-src で決まり、blob: の Worker を作れず HEIC を送れない。古い Safari では確かめていない）
 * - img-src data: blob: は、端末で縮小した写真のプレビューと QR の画像のため
 * - connect-src の S3 は、写真・景品の画像の署名付き POST の送り先（バケット名は書かず、リージョンのドメインで許す）
 */
export function contentSecurityPolicy(region: string): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-eval'",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' https://*.s3.${region}.amazonaws.com https://s3.${region}.amazonaws.com`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "report-uri /api/csp-report",
  ].join("; ");
}
