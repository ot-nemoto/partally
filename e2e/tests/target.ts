/**
 * テストを流す先。E2E_BASE_URL を付けると、データの入った環境（検証用の環境など）へ向けて流す。
 * 付けなければローカル開発環境（playwright.config.ts の webServer が起動する API と web）。
 * API は `/api/...` の形で呼ぶので、URL はホストまで（パスを付けない）にする
 */
export const REMOTE_URL = process.env.E2E_BASE_URL?.replace(/\/+$/, "") || undefined;
