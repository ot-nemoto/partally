import type { TokenStatus, UserStatus } from "@partally/shared";

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
}
