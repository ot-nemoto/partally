import type { ApiErrorCode, ApiErrorResponse } from "@partally/shared";

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

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case "invalid_token":
        return "この QR コードは無効です。運営に声をかけてください。";
      case "token_already_bound":
        return "この QR コードは既に登録されています。もう一度 QR を読み込んでください。";
      case "epithet_taken":
        return "その二つ名は他の人が使っています。";
      case "invalid_state":
        return e.message && e.message !== e.code
          ? e.message
          : "他の操作で状態が変わっています。画面を更新してください。";
      case "favorite_limit":
        return "お気に入りは上限まで選んでいます。他の写真を外してから選んでください。";
      case "favorites_disabled":
        return "お気に入りの受付は終了しました。";
      case "quiz_closed":
        return "この問題の受付は締め切られました。";
      case "unauthorized":
        return "ログインが必要です。";
      case "bad_request":
        return e.message && e.message !== e.code
          ? `入力内容を確認してください（${e.message}）`
          : "入力内容を確認してください。";
      default:
        return "エラーが発生しました。時間をおいてもう一度お試しください。";
    }
  }
  return "通信に失敗しました。電波の良い場所でもう一度お試しください。";
}
