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
  /** 回答したクイズの数 */
  quizAnswered: number;
  /** 締め切ったクイズで選んだ選択肢の点数の合計。ポイントを伏せている間、参加者向けの応答には無い */
  quizPoints?: number;
  /**
   * 現在の設定で計算したポイント（公開枚数 × 1 枚あたり + 選ばれた数 × 1 件あたり + クイズの点数）。
   * ポイントを伏せている間、参加者向けの応答には無い
   */
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
  | "quiz_closed"
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
  /** 参加者のホーム画面にクイズの点数を表示するか */
  showQuizPoints: boolean;
  /** 参加者にランキングを見せるか */
  rankingVisible: boolean;
  /** 参加者のランキングで名前を伏せるか */
  rankingHideNames: boolean;
  /** 参加者のランキングでポイントを伏せるか */
  rankingHidePoints: boolean;
  /** 参加者にポイントの推移（トレンド）を見せるか */
  trendVisible: boolean;
  /** 参加者のトレンドで名前を伏せるか */
  trendHideNames: boolean;
  /** 参加者のトレンドでポイントを伏せるか */
  trendHidePoints: boolean;
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

/** draft: 下書き / open: 出題中（同時に 1 問だけ） / closed: 締め切り */
export type QuizStatus = "draft" | "open" | "closed";

export interface QuizChoiceDto {
  choiceId: string;
  text: string;
  /** 選んだ人に入る点数（管理画面のみ） */
  points?: number;
  /** この選択肢を選んだ人数（管理画面のみ） */
  answerCount?: number;
}

/** 管理画面に返すクイズ */
export interface QuizDto {
  quizId: string;
  text: string;
  status: QuizStatus;
  choices: QuizChoiceDto[];
  /** 回答した人数 */
  answerCount: number;
  createdAt: string;
  openedAt?: string;
  closedAt?: string;
}

export interface QuizzesResponse {
  quizzes: QuizDto[];
}

export interface QuizResponse {
  quiz: QuizDto;
}

export interface QuizAnswerDto {
  userId: string;
  displayName?: string;
  choiceId: string;
  answeredAt: string;
}

export interface QuizResultsResponse {
  quiz: QuizDto;
  answers: QuizAnswerDto[];
}

/** 参加者に返す出題中のクイズ。正解がわからないよう、選択肢の点数は含めない */
export interface CurrentQuizDto {
  quizId: string;
  text: string;
  choices: { choiceId: string; text: string }[];
  /** 自分が選んでいる選択肢 */
  myChoiceId?: string;
}

export interface CurrentQuizResponse {
  quiz: CurrentQuizDto | null;
}

/** 累計ポイントの推移の 1 点 */
export interface RankingPointDto {
  at: string;
  /** その時点までの累計ポイント */
  points: number;
}

export interface RankingEntryDto {
  /** 順位。同点は同じ順位で、次はその人数分飛ばす（1, 1, 3…） */
  rank: number;
  userId: string;
  /** 称号を付けない名前（グラフの線の終わりなど、狭い所に出す） */
  name: string;
  /** 称号（二つ名） */
  epithet: string;
  displayName: string;
  status: UserStatus;
  /** ユーザ管理と同じく、現在の設定で計算したポイント */
  points: number;
  /** 登録時の 0 から現在までの累計ポイント。点が増減した時刻ごとに 1 点、最後は現在の時刻 */
  history: RankingPointDto[];
}

export interface RankingResponse {
  ranking: RankingEntryDto[];
  generatedAt: string;
}

/**
 * 参加者に返すランキング・推移。名前を伏せるときは名前・称号を「???」にし、ユーザ ID も返さない。
 * ポイントを伏せるときは、最大値を 100 とした割合だけを返す
 */
export interface ParticipantRankingResponse extends RankingResponse {
  hideNames: boolean;
  hidePoints: boolean;
}
