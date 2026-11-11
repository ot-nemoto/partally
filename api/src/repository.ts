import {
  type GameFormat,
  type GameStatus,
  type PhotoStatus,
  type Settings,
  TIE_BREAK_KEYS,
  type TokenStatus,
  type UserStatus,
} from "@partally/shared";

export interface TokenRecord {
  token: string;
  label: string;
  status: TokenStatus;
  userId?: string;
  createdAt: string;
  boundAt?: string;
}

export interface UserRecord {
  userId: string;
  name: string;
  epithet: string;
  token?: string;
  status: UserStatus;
  uploadCount: number;
  approvedCount: number;
  favoritesGiven: number;
  favoritesReceived: number;
  createdAt: string;
  updatedAt: string;
}

/** 印刷・配布管理用の通し番号（001, 002, ...） */
export function formatLabel(n: number): string {
  return String(n).padStart(3, "0");
}

/** deleted は管理者が削除した写真の記録。同じ photoId の再取り込みを防ぐために残す */
export type PhotoRecordStatus = PhotoStatus | "deleted";

export interface PhotoRecord {
  photoId: string;
  uploaderId: string;
  status: PhotoRecordStatus;
  favoriteCount: number;
  createdAt: string;
  reviewedAt?: string;
}

/** お気に入り（userId が photoId を選んだ） */
export interface FavoriteRecord {
  userId: string;
  photoId: string;
  createdAt: string;
}

export interface PrizeRecord {
  prizeId: string;
  name: string;
  quantity: number;
  /** 渡す順位（小さい順） */
  positions: number[];
  imageId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleItemRecord {
  itemId: string;
  title: string;
  detail: string;
  /** 0:00 からの分 */
  startMinute: number;
  durationMinutes: number;
  createdAt: string;
  updatedAt: string;
}

export interface GameSlot {
  slotId: string;
  name: string;
  points: number;
  userIds: string[];
}

/** クイズ形式の選択肢 */
export interface GameChoice {
  choiceId: string;
  text: string;
  points: number;
  /** 画像（景品と同じ置き場の `prizes/<imageId>.jpg`）。無ければ画像なし */
  imageId?: string;
}

/** 数値予想の点数の範囲 */
export interface GameRank {
  from: number;
  to: number;
  points: number;
}

export interface GameRecord {
  gameId: string;
  format: GameFormat;
  name: string;
  description: string;
  /** 問題（ゲーム本体）の画像（景品と同じ置き場の `prizes/<imageId>.jpg`）。無ければ画像なし */
  imageId?: string;
  status: GameStatus;
  /** 結果入力形式の枠（クイズ形式では空） */
  slots: GameSlot[];
  /** クイズ形式の選択肢（ほかの形式では空） */
  choices: GameChoice[];
  /** 数値予想・投票の点数の範囲（ほかの形式では空。from の小さい順） */
  ranks: GameRank[];
  /** 数値予想の正解の数。まだ決めていなければ無い */
  correctNumber?: number;
  /** 投票で、投票した人に入る点数（ほかの形式では 0） */
  voterPoints: number;
  /** 合言葉（ほかの形式では無い） */
  keyword?: string;
  /** 抽選で、確定したときに決めた順番（userId の並び）。確定を取り消すと消える */
  drawOrder?: string[];
  createdAt: string;
  updatedAt: string;
  /** 最後に開催した時刻 */
  openedAt?: string;
  /** 確定した時刻。確定を取り消すと消える */
  confirmedAt?: string;
}

/** ゲームを直すときに変える項目（形式・状態・時刻は変えない） */
export type GameChanges = Pick<
  GameRecord,
  "name" | "description" | "imageId" | "slots" | "choices" | "ranks" | "correctNumber" | "voterPoints" | "keyword"
>;

/** クイズ・数値予想・投票・合言葉のゲームへの答え。1 人 1 ゲームにつき 1 件で、答え直すと上書きする */
export interface GameAnswerRecord {
  gameId: string;
  userId: string;
  /** クイズで選んだ選択肢 */
  choiceId?: string;
  /** 数値予想で答えた数 */
  value?: number;
  /** 投票で選んだ人 */
  targetUserId?: string;
  /** 合言葉で正解した言葉（正解したときだけ保存する） */
  text?: string;
  /** 抽選に参加した */
  entry?: boolean;
  answeredAt: string;
}

export interface Page<T> {
  items: T[];
  /** 続きがある場合の位置。次の呼び出しにそのまま渡す */
  cursor?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  moderation: "pre",
  uploadPoints: 1,
  favoritesEnabled: true,
  favoriteLimit: 10,
  favoritePoints: 1,
  favoriteGivenPoints: 10,
  showPoints: true,
  showGamePoints: true,
  // 参加者へのランキング・トレンドは、管理者が見せると決めるまで出さない
  rankingVisible: false,
  rankingHideNames: false,
  rankingHidePoints: false,
  trendVisible: false,
  trendHideNames: false,
  trendHidePoints: false,
  prizesVisible: false,
  tieBreakOrder: [...TIE_BREAK_KEYS],
  scheduleVisible: false,
  scheduleDate: "",
};

export interface UserChanges {
  name?: string;
  epithet?: string;
}

/** 未紐づけでないトークンに登録しようとした */
export class TokenNotAvailableError extends Error {
  constructor() {
    super("token is not available");
    this.name = "TokenNotAvailableError";
  }
}

/** 二つ名が既に使われている */
export class EpithetTakenError extends Error {
  constructor() {
    super("epithet is already taken");
    this.name = "EpithetTakenError";
  }
}

/** 写真の状態が操作の前提と合わない（承認済みを承認しようとした等） */
export class InvalidStateError extends Error {
  constructor() {
    super("invalid state");
    this.name = "InvalidStateError";
  }
}

/** お気に入りの上限に達している */
export class FavoriteLimitError extends Error {
  constructor() {
    super("favorite limit reached");
    this.name = "FavoriteLimitError";
  }
}

/** 別のゲームが開催中 */
export class GameAlreadyOpenError extends Error {
  constructor() {
    super("another game is open");
    this.name = "GameAlreadyOpenError";
  }
}

export class NotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "NotFoundError";
  }
}

export interface Repository {
  getToken(token: string): Promise<TokenRecord | undefined>;
  getUser(userId: string): Promise<UserRecord | undefined>;
  /** 指定したユーザをまとめて取得する（存在しない ID は結果に含まれない） */
  getUsers(userIds: string[]): Promise<UserRecord[]>;
  listTokens(): Promise<TokenRecord[]>;
  listUsers(): Promise<UserRecord[]>;

  /** 通し番号を採番してトークンを作成する。tokens は呼び出し側で生成したランダム値 */
  createTokens(tokens: string[], createdAt: string): Promise<TokenRecord[]>;

  /**
   * 未紐づけトークンにユーザを登録する。トークンの紐づけ・ユーザ作成・二つ名の確保は不可分に行う。
   * @throws TokenNotAvailableError トークンが存在しないか紐づけ済み
   * @throws EpithetTakenError 二つ名が使用済み
   */
  registerUser(user: UserRecord & { token: string }): Promise<void>;

  /**
   * @throws NotFoundError ユーザが存在しない
   * @throws EpithetTakenError 変更後の二つ名が使用済み
   */
  updateUser(userId: string, changes: UserChanges, updatedAt: string): Promise<UserRecord>;

  /**
   * ユーザと QR トークンの紐づけを解除する。
   * @throws NotFoundError ユーザが存在しないか、既に解除済み
   */
  unbindUser(userId: string, updatedAt: string): Promise<UserRecord>;

  // ---- 写真 ----

  /**
   * 写真を読む。consistent を付けると、直前の更新も必ず反映した値を読む
   * （更新に失敗した直後に、今の状態で後片付けを決めるときに使う）
   */
  getPhoto(photoId: string, options?: { consistent?: boolean }): Promise<PhotoRecord | undefined>;

  /** 状態別に新しい順で返す */
  listPhotosByStatus(status: PhotoStatus, limit: number, cursor?: string): Promise<Page<PhotoRecord>>;

  /** アップロード者別に新しい順で返す（削除済みも含む） */
  listPhotosByUploader(uploaderId: string): Promise<PhotoRecord[]>;

  /**
   * 写真を登録し、アップロード者の uploadCount（approved なら approvedCount も）を加算する。
   * 同じ photoId が既にあれば何もせず false を返す（S3 イベントの重複配信に備える）。
   */
  createPhoto(photo: PhotoRecord): Promise<boolean>;

  /**
   * pending → approved。approvedCount を加算する。
   * @throws NotFoundError / InvalidStateError
   */
  approvePhoto(photoId: string, reviewedAt: string): Promise<PhotoRecord>;

  /**
   * pending → rejected。uploadCount を減算する。
   * @throws NotFoundError / InvalidStateError
   */
  rejectPhoto(photoId: string, reviewedAt: string): Promise<PhotoRecord>;

  /**
   * approved → deleted。uploadCount・approvedCount を減算する。
   * @throws NotFoundError / InvalidStateError
   */
  deleteApprovedPhoto(photoId: string, deletedAt: string): Promise<PhotoRecord>;

  // ---- お気に入り ----

  /**
   * userId が photo をお気に入りに加える。選んだ人の favoritesGiven、写真の favoriteCount、
   * アップロード者の favoritesReceived を同時に加算する。既に選んでいれば何もしない。
   * @throws FavoriteLimitError 選んだ数が limit に達している
   * @throws InvalidStateError 写真が公開中でない
   */
  addFavorite(userId: string, photo: PhotoRecord, limit: number, createdAt: string): Promise<void>;

  /** お気に入りを外し、各カウンタを減算する。選んでいなければ何もしない */
  removeFavorite(userId: string, photo: PhotoRecord): Promise<void>;

  /** userId が選んでいる写真の ID */
  listFavoritePhotoIds(userId: string): Promise<string[]>;

  /** photoId へのお気に入り（選んだ人と時刻） */
  listFavoritesOfPhoto(photoId: string): Promise<FavoriteRecord[]>;

  /** photoId へのお気に入りをすべて外す（写真の削除時） */
  clearFavorites(photoId: string): Promise<void>;

  // ---- 景品 ----

  createPrize(prize: PrizeRecord): Promise<void>;
  getPrize(prizeId: string): Promise<PrizeRecord | undefined>;
  /** 作成順（古い順）で返す */
  listPrizes(): Promise<PrizeRecord[]>;
  /**
   * 名前・数量・順位・画像を差し替える。
   * @throws NotFoundError
   */
  updatePrize(
    prizeId: string,
    changes: Pick<PrizeRecord, "name" | "quantity" | "positions" | "imageId">,
    updatedAt: string,
  ): Promise<PrizeRecord>;
  /** @throws NotFoundError */
  deletePrize(prizeId: string): Promise<void>;

  // ---- スケジュール ----

  createScheduleItem(item: ScheduleItemRecord): Promise<void>;
  /** 作成順（古い順）で返す */
  listScheduleItems(): Promise<ScheduleItemRecord[]>;
  /** @throws NotFoundError */
  updateScheduleItem(
    itemId: string,
    changes: Pick<ScheduleItemRecord, "title" | "detail" | "startMinute" | "durationMinutes">,
    updatedAt: string,
  ): Promise<ScheduleItemRecord>;
  /** @throws NotFoundError */
  deleteScheduleItem(itemId: string): Promise<void>;

  // ---- ゲーム ----

  createGame(game: GameRecord): Promise<void>;
  getGame(gameId: string): Promise<GameRecord | undefined>;
  /** 作成順（古い順）で返す */
  listGames(): Promise<GameRecord[]>;
  /**
   * 名前・説明・枠・選択肢を差し替える（開催中・確定済みでも直せる）。expectedUpdatedAt を渡すと、保存済みの updatedAt がそれと同じときだけ差し替える。
   * @throws NotFoundError / InvalidStateError ほかで直されていた
   */
  updateGame(gameId: string, changes: GameChanges, updatedAt: string, expectedUpdatedAt?: string): Promise<GameRecord>;
  /**
   * 状態を from から to に変える。開催中（open）は同時に 1 つだけで、開催中の印を一緒に作る・消す。
   * 確定（confirmed）にすると confirmedAt を付け、確定から戻すと消す。開催すると openedAt を付ける。
   * @throws NotFoundError / InvalidStateError 今の状態が from でない / GameAlreadyOpenError 別のゲームが開催中
   */
  changeGameStatus(
    gameId: string,
    from: GameStatus,
    to: GameStatus,
    at: string,
    /** 確定するときに保存する抽選の順番（確定から戻すと消える） */
    drawOrder?: string[],
  ): Promise<GameRecord>;
  /** 開催中のゲームの ID */
  getOpenGameId(): Promise<string | undefined>;
  /** ゲームと、その答えを削除する。@throws NotFoundError / InvalidStateError 開催中 */
  deleteGame(gameId: string): Promise<void>;

  /**
   * クイズ形式の答えを保存する（選び直しは上書き）。開催中かどうかは呼び出し側が強い整合性で読んで確かめ、
   * その後に answeredAt を付けて呼ぶ（全員が一斉に答えるため、ゲームのアイテムを含むトランザクションにはしない）
   */
  putGameAnswer(answer: GameAnswerRecord): Promise<void>;
  getGameAnswer(userId: string, gameId: string): Promise<GameAnswerRecord | undefined>;
  listGameAnswersByUser(userId: string): Promise<GameAnswerRecord[]>;
  listGameAnswersByGame(gameId: string): Promise<GameAnswerRecord[]>;

  // ---- 設定 ----

  getSettings(): Promise<Settings>;
  putSettings(settings: Settings): Promise<void>;
}
