export type UserStatus = "active" | "unbound";
export type TokenStatus = "unbound" | "bound";

/** 参加者自身・管理画面に返すユーザ情報 */
export interface UserDto {
  userId: string;
  name: string;
  epithet: string;
  displayName: string;
  status: UserStatus;
  uploadCount: number;
  approvedCount: number;
  createdAt: string;
}

export interface TokenDto {
  token: string;
  label: string;
  status: TokenStatus;
  userId?: string;
  displayName?: string;
  createdAt: string;
  boundAt?: string;
}

export type QrLoginResponse =
  | { status: "bound"; user: UserDto }
  | { status: "unbound" };

export interface RegisterResponse {
  user: UserDto;
}

export interface MeResponse {
  user: UserDto;
}

export interface TokensResponse {
  tokens: TokenDto[];
}

export interface UsersResponse {
  users: UserDto[];
}

export interface UserResponse {
  user: UserDto;
}

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "invalid_token"
  | "token_already_bound"
  | "epithet_taken"
  | "invalid_state"
  | "not_found"
  | "internal_error";

export interface ApiErrorResponse {
  error: ApiErrorCode;
  message?: string;
}

export type PhotoStatus = "pending" | "approved" | "rejected";

/** pre: 管理者の承認後に公開 / post: 即時公開（管理者は事後に削除） */
export type ModerationMode = "pre" | "post";

export interface PhotoDto {
  photoId: string;
  uploaderId: string;
  uploaderName?: string;
  status: PhotoStatus;
  /** 一覧用サムネイルの URL（同一オリジンの相対パス）。却下済みには無い */
  thumbUrl?: string;
  /** 本体画像の URL */
  fullUrl?: string;
  createdAt: string;
  reviewedAt?: string;
}

export interface PhotosResponse {
  photos: PhotoDto[];
  /** 続きがある場合に次のリクエストへ渡す値 */
  cursor?: string;
}

export interface PhotoResponse {
  photo: PhotoDto;
}

/** S3 への署名付き POST。fields をフォームに入れ、最後に file を付けて url へ送る */
export interface PresignedPost {
  url: string;
  fields: Record<string, string>;
}

export interface UploadUrlResponse {
  photoId: string;
  full: PresignedPost;
  thumb: PresignedPost;
}

export interface Settings {
  moderation: ModerationMode;
}

export interface SettingsResponse {
  settings: Settings;
}
