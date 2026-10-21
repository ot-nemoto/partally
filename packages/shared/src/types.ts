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
  /** 自分が選んだお気に入りの数 */
  favoritesGiven: number;
  /** 自分の写真が他の人にお気に入りに選ばれた数。ポイントを伏せている間、参加者向けの応答には無い */
  favoritesReceived?: number;
  /** 現在の設定で計算したポイント（公開枚数 × 1 枚あたり + 選ばれた数 × 1 件あたり）。ポイントを伏せている間、参加者向けの応答には無い */
  points?: number;
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

export type QrLoginResponse = { status: "bound"; user: UserDto } | { status: "unbound" };

export interface RegisterResponse {
  user: UserDto;
}

export interface MeResponse {
  user: UserDto;
  rules: Rules;
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
  | "favorites_disabled"
  | "favorite_limit"
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
  /** 他の人にお気に入りに選ばれた数。ポイントを伏せている間、参加者向けの応答には無い */
  favoriteCount?: number;
  /** 自分がお気に入りに選んでいるか（参加者の一覧のみ） */
  favorited?: boolean;
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
  /** 写真 1 枚が公開されたときのポイント */
  uploadPoints: number;
  /** お気に入りの選択（追加・解除）を受け付けるか。無効にしても付いたポイントは残る */
  favoritesEnabled: boolean;
  /** 1 人が選べるお気に入りの数 */
  favoriteLimit: number;
  /** お気に入りに 1 件選ばれたときのポイント */
  favoritePoints: number;
  /** 参加者のホーム画面にポイントを表示するか（発表まで伏せておきたいときに切る） */
  showPoints: boolean;
}

/** 参加者に見せるポイントのルール（設定のうち公開してよい部分） */
export type Rules = Omit<Settings, "moderation">;

export interface FavoriteResponse {
  photo: PhotoDto;
  user: UserDto;
}

export interface SettingsResponse {
  settings: Settings;
}
