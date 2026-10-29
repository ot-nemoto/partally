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
  // 以下は後から追加した項目。古い画面から保存されても 400 にせず、今の値を残す
  favoriteGivenPoints: points.optional(),
  showPoints: z.boolean().optional(),
  showQuizPoints: z.boolean().optional(),
  rankingVisible: z.boolean().optional(),
  rankingHideNames: z.boolean().optional(),
  rankingHidePoints: z.boolean().optional(),
  trendVisible: z.boolean().optional(),
  trendHideNames: z.boolean().optional(),
  trendHidePoints: z.boolean().optional(),
});

export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;

export const QUIZ_TEXT_MAX_LENGTH = 500;
export const QUIZ_CHOICE_TEXT_MAX_LENGTH = 100;
export const QUIZ_CHOICES_MIN = 2;
export const QUIZ_CHOICES_MAX = 10;

/**
 * 問題文は書いたとおりに残す（前後の空白だけ除き、改行や全角の記号はそのまま）。
 * 選択肢は 1 行なので、連続する空白も 1 つにする
 */
const quizText = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1).max(QUIZ_TEXT_MAX_LENGTH));
const quizChoiceText = z
  .string()
  .transform((s) => s.trim().replace(/\s+/g, " "))
  .pipe(z.string().min(1).max(QUIZ_CHOICE_TEXT_MAX_LENGTH));

/** choiceId は既存の選択肢を直すときに指定する。新しい選択肢には付けない */
export const quizRequestSchema = z.object({
  text: quizText,
  choices: z
    .array(
      z.object({
        choiceId: z.string().min(1).max(40).optional(),
        text: quizChoiceText,
        points,
      }),
    )
    .min(QUIZ_CHOICES_MIN)
    .max(QUIZ_CHOICES_MAX),
});

export const quizAnswerRequestSchema = z.object({
  choiceId: z.string().min(1).max(40),
});

export type QuizRequest = z.infer<typeof quizRequestSchema>;
export type QuizAnswerRequest = z.infer<typeof quizAnswerRequestSchema>;
