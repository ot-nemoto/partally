import type { ApiErrorCode, ApiErrorResponse } from "@partally/shared";
import { getLang, tr } from "./i18n";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ApiError";
  }
}

/** 同一オリジンの /api を呼ぶ。Cookie は自動で送られる */
export async function api<T>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: method === "GET" ? undefined : { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    credentials: "same-origin",
  });
  const json = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const err = json as Partial<ApiErrorResponse>;
    throw new ApiError(res.status, err.error ?? "internal_error", err.message);
  }
  return json as T;
}

/** エラーを、画面の言語の文にする（サーバの説明は日本語なので、英語の画面では決まった文にする） */
export function errorMessage(e: unknown): string {
  const en = getLang() === "en";
  if (e instanceof ApiError) {
    const detail = e.message && e.message !== e.code ? e.message : undefined;
    switch (e.code) {
      case "invalid_token":
        return tr(
          "この QR コードは無効です。運営に声をかけてください。",
          "This QR code is not valid. Please ask the organizers.",
        );
      case "token_already_bound":
        return tr(
          "この QR コードは既に登録されています。もう一度 QR を読み込んでください。",
          "This QR code is already registered. Please scan it again.",
        );
      case "epithet_taken":
        return tr("その二つ名は他の人が使っています。", "That title is already used by someone else.");
      case "pin_invalid": {
        // サーバの説明は「あと N 回」
        const left = detail && /\d+/.exec(detail)?.[0];
        if (en) return `Wrong PIN${left ? ` (${left} ${left === "1" ? "try" : "tries"} left)` : ""}.`;
        return `暗証番号が違います${detail ? `（${detail}）` : ""}。`;
      }
      case "pin_locked":
        return tr(
          "暗証番号を続けて間違えたため、ロックしました。運営に声をかけてください。",
          "Too many wrong PINs, so this QR code is locked. Please ask the organizers.",
        );
      case "invalid_state":
        // サーバの理由は日本語だけなので、英語の画面では決まった文に添える
        if (en) return `This can’t be done right now.${detail ? ` (${detail})` : " Please refresh."}`;
        return detail ?? "他の操作で状態が変わっています。画面を更新してください。";
      case "favorite_limit":
        return tr(
          "お気に入りは上限まで選んでいます。他の写真を外してから選んでください。",
          "You’ve reached the favorites limit. Remove one before choosing another.",
        );
      case "favorites_disabled":
        return tr("お気に入りの受付は終了しました。", "Favorites are closed.");
      case "game_closed":
        return tr("このゲームの受付は終わりました。", "This game is closed.");
      case "already_answered":
        return tr("このゲームには、もう答えています。", "You’ve already answered this game.");
      case "unauthorized":
        return tr("ログインが必要です。", "Please log in.");
      case "image_not_uploaded":
        return tr(
          "画像を保存できませんでした。画像を選び直してから保存してください。",
          "The image couldn’t be saved. Please choose it again and save.",
        );
      case "bad_request":
        if (en) return `Please check what you entered.${detail ? ` (${detail})` : ""}`;
        return detail ? `入力内容を確認してください（${detail}）` : "入力内容を確認してください。";
      default:
        return tr(
          "エラーが発生しました。時間をおいてもう一度お試しください。",
          "Something went wrong. Please try again in a moment.",
        );
    }
  }
  return tr(
    "通信に失敗しました。電波の良い場所でもう一度お試しください。",
    "Connection failed. Please try again where the signal is better.",
  );
}
