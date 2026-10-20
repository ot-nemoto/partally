import type { PhotoStatus, Settings, TokenStatus, UserStatus } from "@partally/shared";

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
  createdAt: string;
  updatedAt: string;
}

/** 印刷・配布管理用の通し番号（001, 002, ...） */
export function formatLabel(n: number): string {
  return String(n).padStart(3, "0");
}

export interface PhotoRecord {
  photoId: string;
  uploaderId: string;
  status: PhotoStatus;
  createdAt: string;
  reviewedAt?: string;
}

export interface Page<T> {
  items: T[];
  /** 続きがある場合の位置。次の呼び出しにそのまま渡す */
  cursor?: string;
}

export const DEFAULT_SETTINGS: Settings = { moderation: "pre" };

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

export class NotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "NotFoundError";
  }
}

export interface Repository {
  getToken(token: string): Promise<TokenRecord | undefined>;
  getUser(userId: string): Promise<UserRecord | undefined>;
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

  /** アップロード者別に新しい順で返す */
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
   * 公開済みの写真を削除し、uploadCount・approvedCount を減算する。
   * @throws NotFoundError / InvalidStateError
   */
  deleteApprovedPhoto(photoId: string): Promise<PhotoRecord>;

  // ---- 設定 ----

  getSettings(): Promise<Settings>;
  putSettings(settings: Settings): Promise<void>;
}
