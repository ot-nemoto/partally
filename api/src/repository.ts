import type { PhotoStatus, QuizStatus, Settings, TokenStatus, UserStatus } from "@partally/shared";

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

export interface QuizChoice {
  choiceId: string;
  text: string;
  points: number;
}

export interface QuizRecord {
  quizId: string;
  text: string;
  choices: QuizChoice[];
  status: QuizStatus;
  createdAt: string;
  updatedAt: string;
  openedAt?: string;
  closedAt?: string;
}

/** クイズへの回答。1 人 1 問につき 1 件で、選び直すと上書きする */
export interface QuizAnswerRecord {
  quizId: string;
  userId: string;
  choiceId: string;
  answeredAt: string;
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
  showQuizPoints: true,
  // 参加者へのランキング・トレンドは、管理者が見せると決めるまで出さない
  rankingVisible: false,
  rankingHideNames: false,
  rankingHidePoints: false,
  trendVisible: false,
  trendHideNames: false,
  trendHidePoints: false,
  prizesVisible: false,
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

/** 別のクイズが出題中 */
export class QuizAlreadyOpenError extends Error {
  constructor() {
    super("another quiz is open");
    this.name = "QuizAlreadyOpenError";
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

  getPhoto(photoId: string): Promise<PhotoRecord | undefined>;

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

  // ---- クイズ ----

  createQuiz(quiz: QuizRecord): Promise<void>;
  getQuiz(quizId: string): Promise<QuizRecord | undefined>;
  /** 作成順（古い順）で返す */
  listQuizzes(): Promise<QuizRecord[]>;

  /**
   * 問題文と選択肢を差し替える。onlyIfDraft なら下書きのときだけ（選択肢の追加・削除は下書きの間だけにするため）。
   * @throws NotFoundError / InvalidStateError
   */
  updateQuiz(
    quizId: string,
    changes: Pick<QuizRecord, "text" | "choices">,
    updatedAt: string,
    onlyIfDraft: boolean,
  ): Promise<QuizRecord>;

  /**
   * 下書きか締め切り済みのクイズと、その回答を削除する。
   * @throws NotFoundError / InvalidStateError 出題中
   */
  deleteQuiz(quizId: string): Promise<void>;

  /**
   * draft → open。出題中は同時に 1 問だけ。
   * @throws NotFoundError / InvalidStateError 下書きでない / QuizAlreadyOpenError 別のクイズが出題中
   */
  openQuiz(quizId: string, openedAt: string): Promise<QuizRecord>;

  /**
   * open → closed。
   * @throws NotFoundError / InvalidStateError 出題中でない
   */
  closeQuiz(quizId: string, closedAt: string): Promise<QuizRecord>;

  /** 出題中のクイズの ID */
  getOpenQuizId(): Promise<string | undefined>;

  /**
   * 回答を保存する（選び直しは上書き）。出題中かどうかは呼び出し側が強い整合性で読んで確かめ、
   * その後に answeredAt を付けて呼ぶ（全員が一斉に答えるため、クイズのアイテムを含むトランザクションにはしない）
   */
  putQuizAnswer(answer: QuizAnswerRecord): Promise<void>;
  getQuizAnswer(userId: string, quizId: string): Promise<QuizAnswerRecord | undefined>;
  listQuizAnswersByUser(userId: string): Promise<QuizAnswerRecord[]>;
  listQuizAnswersByQuiz(quizId: string): Promise<QuizAnswerRecord[]>;

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

  // ---- 設定 ----

  getSettings(): Promise<Settings>;
  putSettings(settings: Settings): Promise<void>;
}
