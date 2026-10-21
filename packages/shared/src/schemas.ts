import { z } from "zod";
import { EPITHET_MAX_LENGTH } from "./epithet.js";

export const NAME_MAX_LENGTH = 20;
export const TOKEN_ISSUE_MAX = 200;

/** 全角英数を半角に揃え、前後の空白を除き、連続する空白を 1 つにする */
export function normalizeText(input: string): string {
  return input.normalize("NFKC").trim().replace(/\s+/g, " ");
}

const normalized = (max: number) => z.string().transform(normalizeText).pipe(z.string().min(1).max(max));

export const nameSchema = normalized(NAME_MAX_LENGTH);
export const epithetSchema = normalized(EPITHET_MAX_LENGTH);

/** 128bit 乱数の base64url 表現（22 文字） */
export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

export const qrLoginRequestSchema = z.object({ token: tokenSchema });

export const registerRequestSchema = z.object({
  token: tokenSchema,
  name: nameSchema,
});

export const adminLoginRequestSchema = z.object({
  password: z.string().min(1).max(256),
});

export const issueTokensRequestSchema = z.object({
  count: z.number().int().min(1).max(TOKEN_ISSUE_MAX),
});

export const updateUserRequestSchema = z
  .object({
    name: nameSchema.optional(),
    epithet: epithetSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.epithet !== undefined, {
    message: "name か epithet のどちらかを指定してください",
  });

export type QrLoginRequest = z.infer<typeof qrLoginRequestSchema>;
export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type AdminLoginRequest = z.infer<typeof adminLoginRequestSchema>;
export type IssueTokensRequest = z.infer<typeof issueTokensRequestSchema>;
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

export const PHOTO_FULL_MAX_BYTES = 5 * 1024 * 1024;
export const PHOTO_THUMB_MAX_BYTES = 500 * 1024;
export const PHOTO_FULL_MAX_EDGE = 1600;
export const PHOTO_THUMB_MAX_EDGE = 400;

export const photoStatusSchema = z.enum(["pending", "approved", "rejected"]);

export const POINTS_MAX = 100;
export const FAVORITE_LIMIT_MAX = 100;

const points = z.number().int().min(0).max(POINTS_MAX);

export const updateSettingsRequestSchema = z.object({
  moderation: z.enum(["pre", "post"]),
  uploadPoints: points,
  favoritesEnabled: z.boolean(),
  favoriteLimit: z.number().int().min(0).max(FAVORITE_LIMIT_MAX),
  favoritePoints: points,
  showPoints: z.boolean(),
});

export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;
