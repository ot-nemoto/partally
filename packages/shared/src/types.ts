import type { GAME_FORMATS, POINT_KEYS, TIE_BREAK_KEYS } from "./schemas.js";

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
  /** 確定したゲームで入った点数の合計。ゲームの点数を伏せている間、参加者向けの応答には無い */
  gamePoints?: number;
  /** 確定したゲームで点数が入ったもの（確定した順）。参加者本人にだけ返し、ゲームの点数を伏せている間は無い */
  gameAwards?: GameAwardDto[];
  /**
   * 現在の設定で計算したポイント（公開枚数 × 1 枚あたり + 選ばれた数 × 1 件あたり + 選んだ数 × 1 枚あたり + ゲームの点数）。
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
  | "game_closed"
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
  /** お気に入りに 1 件選ばれたときのポイント（選ばれた人に入る） */
  favoritePoints: number;
  /** お気に入りを 1 枚選んだときのポイント（選んだ人に入る） */
  favoriteGivenPoints: number;
  /** 参加者のホーム画面にポイントを表示するか（発表まで伏せておきたいときに切る） */
  showPoints: boolean;
  /** 参加者のホーム画面にゲームの点数と、入った枠を表示するか */
  showGamePoints: boolean;
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
  /** 参加者に景品（何位で何がもらえるか）を見せるか */
  prizesVisible: boolean;
  /**
   * 合計が同じ人の順位の決め方。先頭の項目から順に比べ、ポイントの項目は多い人、登録順は先に登録した人を上にする。
   * 順位は必ず分ける（同じ順位は作らない）
   */
  tieBreakOrder: TieBreakKey[];
  /** 参加者にスケジュールを見せるか */
  scheduleVisible: boolean;
  /** イベントの日付（YYYY-MM-DD）。空なら日付を決めない（参加者の「いま」「つぎ」は毎日の時刻で判定する） */
  scheduleDate: string;
}

/** 同じポイントのときに比べる項目（一覧は TIE_BREAK_KEYS） */
export type TieBreakKey = (typeof TIE_BREAK_KEYS)[number];

/** ポイントの内訳の項目（一覧は POINT_KEYS） */
export type PointKey = (typeof POINT_KEYS)[number];

/** 参加者に見せるポイントのルール（設定のうち公開してよい部分） */
export type Rules = Omit<Settings, "moderation">;

export interface FavoriteResponse {
  photo: PhotoDto;
  user: UserDto;
}

export interface SettingsResponse {
  settings: Settings;
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

/** 景品。positions は渡す順位（上から何番目の人か。同点は先に登録した人を上にする）を小さい順に並べたもの */
export interface PrizeDto {
  prizeId: string;
  name: string;
  quantity: number;
  positions: number[];
  /** 画像の ID。更新で同じ画像のままにするときはこれを送る */
  imageId?: string;
  /** 画像の URL（同一オリジンの署名付きパス）。画像が無ければ無い */
  imageUrl?: string;
  createdAt: string;
}

export interface PrizesResponse {
  prizes: PrizeDto[];
}

export interface PrizeResponse {
  prize: PrizeDto;
}

/** 景品の画像を 1 枚アップロードするための署名付き POST。保存するときに imageId を景品に付ける */
export interface PrizeImageUploadResponse {
  imageId: string;
  upload: PresignedPost;
}

/** スケジュールの項目。時刻は 0:00 からの分 */
export interface ScheduleItemDto {
  itemId: string;
  title: string;
  detail: string;
  startMinute: number;
  durationMinutes: number;
}

/** スケジュール（開始時刻の早い順）とイベントの日付 */
export interface ScheduleResponse {
  items: ScheduleItemDto[];
  /** YYYY-MM-DD。空なら日付を決めていない */
  date: string;
}

export interface ScheduleItemResponse {
  item: ScheduleItemDto;
}

/**
 * draft: 下書き（ポイントは入らない） / open: 開催中（参加者に知らせる。同時に 1 つだけ。ポイントはまだ入らない） /
 * confirmed: 確定（確定した時刻でポイントが入る）
 */
export type GameStatus = "draft" | "open" | "confirmed";

/** ゲームの形式（一覧は GAME_FORMATS） */
export type GameFormat = (typeof GAME_FORMATS)[number];

/** 結果入力形式の枠。userIds の人に points が入る */
export interface GameSlotDto {
  slotId: string;
  name: string;
  points: number;
  userIds: string[];
}

/** クイズ形式の選択肢。選んだ人に points が入る */
export interface GameChoiceDto {
  choiceId: string;
  text: string;
  points: number;
  /** この選択肢を選んだ人数（管理画面のみ） */
  answerCount: number;
}

/** 管理画面に返すゲーム */
export interface GameDto {
  gameId: string;
  format: GameFormat;
  name: string;
  /** 説明（ルールなど。クイズなら問題文。改行可、空でもよい） */
  description: string;
  status: GameStatus;
  /** 結果入力形式の枠（クイズ形式では空） */
  slots: GameSlotDto[];
  /** クイズ形式の選択肢（結果入力形式では空） */
  choices: GameChoiceDto[];
  /** クイズ形式で答えた人数 */
  answerCount: number;
  createdAt: string;
  /** 最後に開催した時刻 */
  openedAt?: string;
  /** 最後に変えた時刻（名前・説明・枠・選択肢・人・状態）。更新のときに baseUpdatedAt として送り返す */
  updatedAt: string;
  /** 確定した時刻（推移ではこの時刻にポイントが入る）。下書き・開催中には無い */
  confirmedAt?: string;
}

/**
 * 参加者に見せる開催中のゲーム。誰がどの枠に入ったかと、クイズの選択肢の点数（正解が分かる）は含めない
 */
export interface CurrentGameDto {
  gameId: string;
  format: GameFormat;
  name: string;
  description: string;
  /** 結果入力形式の枠と点数 */
  slots: { name: string; points: number }[];
  /** クイズ形式の選択肢 */
  choices: { choiceId: string; text: string }[];
  /** クイズ形式で自分が選んでいる選択肢 */
  myChoiceId?: string;
}

export interface CurrentGameResponse {
  game: CurrentGameDto | null;
}

export interface GamesResponse {
  games: GameDto[];
}

export interface GameResponse {
  game: GameDto;
}

export interface GameAnswerDto {
  userId: string;
  displayName?: string;
  choiceId: string;
  answeredAt: string;
}

/** クイズ形式のゲームと、答えた人の一覧（管理画面） */
export interface GameAnswersResponse {
  game: GameDto;
  answers: GameAnswerDto[];
}

/** 参加者に見せる、自分に点数が入ったゲーム（結果入力なら入った枠、クイズなら選んだ答え） */
export interface GameAwardDto {
  gameName: string;
  /** 結果入力なら枠の名前、クイズなら選んだ選択肢 */
  slotName: string;
  points: number;
}
