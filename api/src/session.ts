import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** 参加者セッション。tok を持たせ、紐づけ解除・再紐づけ後の古い Cookie を無効にする */
export interface UserSession {
  uid: string;
  tok: string;
  iat: number;
}

export interface AdminSession {
  adm: true;
  iat: number;
}

export const USER_SESSION_MAX_AGE = 30 * 24 * 60 * 60;
export const ADMIN_SESSION_MAX_AGE = 12 * 60 * 60;

/** `<base64url(JSON)>.<base64url(HMAC-SHA256)>` 形式に署名する */
export function sign(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(body, secret)}`;
}

/** 署名を検証し、maxAge 秒以内に発行されたものならペイロードを返す */
export function verify<T extends { iat: number }>(
  value: string | undefined,
  secret: string,
  maxAge: number,
  nowSeconds: number,
): T | undefined {
  if (!value) return undefined;
  const [body, signature] = value.split(".");
  if (!body || !signature || !safeEqual(signature, mac(body, secret))) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as T;
    if (typeof payload.iat !== "number" || nowSeconds - payload.iat > maxAge) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

/** 長さの違いも漏らさないよう、ハッシュ同士を定数時間で比較する */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function mac(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}
