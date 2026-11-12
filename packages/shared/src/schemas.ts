import { z } from "zod";
import { EPITHET_MAX_LENGTH } from "./epithet.js";
import { hasGameRanks, normalizeKeyword } from "./game-rules.js";
import type { TieBreakKey } from "./types.js";

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

/** ポイントの内訳の項目 */
export const POINT_KEYS = ["upload", "favoriteGiven", "favoriteReceived", "game"] as const;

/**
 * 同じポイントのときに比べる項目（既定の優先順に並べている）。ポイントの内訳の項目と、登録順（先に登録した人が上）。
 * 登録順が入っているので、順位は必ず分かれる
 */
export const TIE_BREAK_KEYS = [...POINT_KEYS, "registered"] as const;

/** 優先順の項目の名前（管理画面・参加者の画面の案内に出す） */
export const TIE_BREAK_LABEL: Record<TieBreakKey, string> = {
  upload: "写真のアップロード",
  favoriteGiven: "お気に入りを選んだ",
  favoriteReceived: "お気に入りに選ばれた",
  game: "ゲーム",
  registered: "登録順",
};
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
  showGamePoints: z.boolean().optional(),
  rankingVisible: z.boolean().optional(),
  rankingHideNames: z.boolean().optional(),
  rankingHidePoints: z.boolean().optional(),
  trendVisible: z.boolean().optional(),
  trendHideNames: z.boolean().optional(),
  trendHidePoints: z.boolean().optional(),
  prizesVisible: z.boolean().optional(),
  tieBreakOrder: z
    .array(z.enum(TIE_BREAK_KEYS))
    .refine((v) => v.length === TIE_BREAK_KEYS.length && new Set(v).size === v.length, {
      message: `優先順は ${TIE_BREAK_KEYS.length} つの項目をすべて 1 回ずつ並べてください`,
    })
    .optional(),
  scheduleVisible: z.boolean().optional(),
  /** イベントの日付（YYYY-MM-DD）。空なら日付を決めない */
  scheduleDate: z
    .union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日付は YYYY-MM-DD で入れてください")])
    .optional(),
});

export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;

export const PRIZE_NAME_MAX_LENGTH = 50;
export const PRIZE_QUANTITY_MAX = 100;
/** 割り当てられる順位の上限（参加者は 80 名程度の想定） */
export const PRIZE_POSITION_MAX = 1000;
export const PRIZE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const PRIZE_IMAGE_MAX_EDGE = 1200;
/** クイズの選択肢の画像の長辺（参加者の画面では小さく並べるので、問題の画像より小さくする） */
export const GAME_CHOICE_IMAGE_MAX_EDGE = 600;

/** サーバが発行する ID（ULID）。画像の ID など、クライアントから受け取るときに形だけ確かめる */
const idSchema = z.string().regex(/^[0-9A-Za-z]{1,40}$/);

/**
 * 景品。positions は渡す順位（上から何番目の人か）で、1 つにつき 1 個を使うので数量まで。
 * 同じ順位に同じ景品を重ねては割り当てない（別の景品なら同じ順位にいくつでも割り当てられる）
 */
export const prizeRequestSchema = z
  .object({
    name: normalized(PRIZE_NAME_MAX_LENGTH),
    quantity: z.number().int().min(1).max(PRIZE_QUANTITY_MAX),
    positions: z.array(z.number().int().min(1).max(PRIZE_POSITION_MAX)).max(PRIZE_QUANTITY_MAX),
    /** 画像のアップロード URL を発行したときの ID。省くと画像なし */
    imageId: idSchema.optional(),
  })
  .refine((v) => new Set(v.positions).size === v.positions.length, {
    message: "同じ順位が重複しています",
    path: ["positions"],
  })
  .refine((v) => v.positions.length <= v.quantity, {
    message: "割り当てる順位の数が数量を超えています",
    path: ["positions"],
  });

export type PrizeRequest = z.infer<typeof prizeRequestSchema>;

export const SCHEDULE_TITLE_MAX_LENGTH = 50;
export const SCHEDULE_DETAIL_MAX_LENGTH = 500;
/** 1 日の分（スケジュールの時刻は 0:00 からの分で持ち、24:00 を越えない） */
export const DAY_MINUTES = 24 * 60;
/** 所要時間の最小（タイムラインの刻みと同じ 5 分） */
export const SCHEDULE_MIN_DURATION = 5;

/**
 * スケジュールの項目。タイトルは 1 行、詳細は書いたとおり（前後の空白だけ除く）。
 * 開始時刻と所要時間は分で持ち、終わりは 24:00 まで
 */
export const scheduleItemRequestSchema = z
  .object({
    title: normalized(SCHEDULE_TITLE_MAX_LENGTH),
    detail: z
      .string()
      .transform((s) => s.trim())
      .pipe(z.string().max(SCHEDULE_DETAIL_MAX_LENGTH)),
    startMinute: z
      .number()
      .int()
      .min(0)
      .max(DAY_MINUTES - SCHEDULE_MIN_DURATION),
    durationMinutes: z.number().int().min(SCHEDULE_MIN_DURATION).max(DAY_MINUTES),
  })
  .refine((v) => v.startMinute + v.durationMinutes <= DAY_MINUTES, {
    message: "終わりの時刻が 24:00 を越えています",
    path: ["durationMinutes"],
  });

export type ScheduleItemRequest = z.infer<typeof scheduleItemRequestSchema>;

export const GAME_NAME_MAX_LENGTH = 50;
export const GAME_DESCRIPTION_MAX_LENGTH = 500;
export const GAME_SLOT_NAME_MAX_LENGTH = 30;
export const GAME_SLOTS_MAX = 20;
export const GAME_CHOICE_TEXT_MAX_LENGTH = 100;
export const GAME_CHOICES_MIN = 2;
export const GAME_CHOICES_MAX = 10;
/** 1 つのゲームで選べる人数の上限（参加者は 80 名程度の想定） */
export const GAME_MEMBERS_MAX = 1000;
/** 数値予想で答えられる数の範囲（整数） */
export const GAME_NUMBER_MIN = 0;
export const GAME_NUMBER_MAX = 100;
/** 数値予想の点数の範囲の数と、順位の上限 */
export const GAME_RANKS_MAX = 20;
export const GAME_RANK_MAX = 1000;

/**
 * ゲームの形式。quiz: 参加者が選択肢から選ぶ / result: 幹事が枠（優勝など）ごとに人を選ぶ /
 * number: 参加者が数を答え、正解に近い順の順位で点数が入る（数値予想・ニアピン） /
 * vote: 参加者が参加者全員から 1 人に投票し、得票の順位で選ばれた人に点数が入る /
 * keyword: 参加者が合言葉を入れ、正解した順（先着順）の順位で点数が入る /
 * lottery: 参加者が「参加する」を押し、確定したときに無作為に決めた順番で点数が入る
 */
export const GAME_FORMATS = ["quiz", "result", "number", "vote", "keyword", "lottery"] as const;

/** 形式の名前（管理画面に出す） */
export const GAME_FORMAT_LABEL: Record<(typeof GAME_FORMATS)[number], string> = {
  quiz: "クイズ",
  result: "結果入力",
  number: "数値予想",
  vote: "投票",
  keyword: "合言葉",
  lottery: "抽選",
};

/** 合言葉の長さの上限 */
export const GAME_KEYWORD_MAX_LENGTH = 50;
const keywordText = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1).max(GAME_KEYWORD_MAX_LENGTH));

const gameNumber = z.number().int().min(GAME_NUMBER_MIN).max(GAME_NUMBER_MAX);

/** 選択肢・枠の名前は 1 行なので、連続する空白も 1 つにする */
const oneLine = (max: number) =>
  z
    .string()
    .transform((s) => s.trim().replace(/\s+/g, " "))
    .pipe(z.string().min(1).max(max));

/**
 * ゲーム。形式は作るときに決め、後から変えない（更新で違う形式を送ると 400）。
 * - quiz: 選択肢（2〜10 個）ごとに点数を決める。slots は送らない
 * - result: 枠（0〜20 個。名前だけで作り、枠は後から足せる）ごとに点数と人を決める。1 人は 1 つの枠にだけ入る。choices は送らない
 * - number: 点数の範囲（順位の始まりと終わり・点数。0〜20 個、重ねない）と、正解の数（確定までに入れる）を決める。choices・slots は送らない
 * - vote: 得票の順位の範囲ごとの点数（number と同じ形）と、投票した人の点数を決める。choices・slots は送らない
 * - keyword: 合言葉と、正解した順の範囲ごとの点数（number と同じ形）を決める。choices・slots は送らない
 * - lottery: 引いた順番の範囲ごとの点数（number と同じ形）を決める。choices・slots は送らない
 * choiceId・slotId は既存の選択肢・枠を直すときに指定する。新しいものには付けない
 */
export const gameRequestSchema = z
  .object({
    format: z.enum(GAME_FORMATS),
    name: normalized(GAME_NAME_MAX_LENGTH),
    /** 説明（クイズなら問題文）。書いたとおりに残す（前後の空白だけ除く）。省くと空 */
    description: z
      .string()
      .transform((s) => s.trim())
      .pipe(z.string().max(GAME_DESCRIPTION_MAX_LENGTH))
      .optional(),
    /** 問題（ゲーム本体）の画像。画像のアップロード URL を発行したときの ID。省くと画像なし */
    imageId: idSchema.optional(),
    choices: z
      .array(
        z.object({
          choiceId: idSchema.optional(),
          text: oneLine(GAME_CHOICE_TEXT_MAX_LENGTH),
          points,
          /** 選択肢の画像。省くと画像なし */
          imageId: idSchema.optional(),
        }),
      )
      .max(GAME_CHOICES_MAX)
      .optional(),
    slots: z
      .array(
        z.object({
          slotId: idSchema.optional(),
          name: oneLine(GAME_SLOT_NAME_MAX_LENGTH),
          points,
          userIds: z.array(idSchema).max(GAME_MEMBERS_MAX),
        }),
      )
      .max(GAME_SLOTS_MAX)
      .optional(),
    /** 数値予想の点数の範囲。from 位〜to 位の人に points を付ける */
    ranks: z
      .array(
        z.object({
          from: z.number().int().min(1).max(GAME_RANK_MAX),
          to: z.number().int().min(1).max(GAME_RANK_MAX),
          points,
        }),
      )
      .max(GAME_RANKS_MAX)
      .optional(),
    /** 数値予想の正解の数。省くとまだ決めていない（確定できない） */
    correctNumber: gameNumber.optional(),
    /** 投票で、投票した人に入る点数。省くと 0（入らない） */
    voterPoints: points.optional(),
    /** 合言葉（参加者には見せない）。合言葉の形式では必須 */
    keyword: keywordText.optional(),
    /**
     * 更新のとき、画面が持っているゲームの updatedAt。保存済みのものと違えば（ほかで直されていれば）上書きせず 409 にする。
     * 省くと確かめない
     */
    baseUpdatedAt: z.string().max(40).optional(),
  })
  .refine((v) => v.format !== "quiz" || ((v.choices?.length ?? 0) >= GAME_CHOICES_MIN && !v.slots?.length), {
    message: `クイズは選択肢を ${GAME_CHOICES_MIN}〜${GAME_CHOICES_MAX} 個にしてください`,
    path: ["choices"],
  })
  .refine((v) => v.format === "quiz" || !v.choices?.length, {
    message: "選択肢を付けられるのはクイズだけです",
    path: ["choices"],
  })
  .refine((v) => v.format === "result" || !v.slots?.length, {
    message: "枠を付けられるのは結果入力だけです",
    path: ["slots"],
  })
  .refine((v) => hasGameRanks(v) || !v.ranks?.length, {
    message: "点数の範囲を付けられるのは数値予想・投票・合言葉・抽選だけです",
    path: ["ranks"],
  })
  .refine((v) => v.format === "number" || v.correctNumber === undefined, {
    message: "正解の数を付けられるのは数値予想だけです",
    path: ["correctNumber"],
  })
  .refine((v) => (v.format === "keyword") === (v.keyword !== undefined), {
    message: "合言葉の形式では合言葉を入れてください（ほかの形式には付けられません）",
    path: ["keyword"],
  })
  .refine((v) => v.keyword === undefined || normalizeKeyword(v.keyword) !== "", {
    message: "合言葉に文字を入れてください",
    path: ["keyword"],
  })
  .refine((v) => v.format === "vote" || !v.voterPoints, {
    message: "投票した人の点数を付けられるのは投票だけです",
    path: ["voterPoints"],
  })
  .refine((v) => (v.ranks ?? []).every((r) => r.from <= r.to), {
    message: "点数の範囲は、始まりの順位を終わりの順位以下にしてください",
    path: ["ranks"],
  })
  .refine(
    (v) => {
      const sorted = [...(v.ranks ?? [])].sort((a, b) => a.from - b.from);
      return sorted.every((r, i) => i === 0 || sorted[i - 1]!.to < r.from);
    },
    { message: "点数の範囲が重なっています（例: 1〜5 位と 6〜10 位のように分けてください）", path: ["ranks"] },
  )
  .refine(
    (v) => {
      const ids = (v.slots ?? []).flatMap((s) => s.userIds);
      return new Set(ids).size === ids.length;
    },
    { message: "同じ人が複数の枠に入っています", path: ["slots"] },
  )
  .refine(
    (v) => {
      const ids = [v.imageId, ...(v.choices ?? []).map((c) => c.imageId)].filter((id) => id !== undefined);
      return new Set(ids).size === ids.length;
    },
    { message: "同じ画像が複数の所で使われています", path: ["choices"] },
  )
  .refine(
    (v) => {
      const ids = [...(v.slots ?? []).map((s) => s.slotId), ...(v.choices ?? []).map((c) => c.choiceId)].filter(
        (id) => id !== undefined,
      );
      return new Set(ids).size === ids.length;
    },
    { message: "同じ枠・選択肢が重複しています", path: ["slots"] },
  );

export type GameRequest = z.infer<typeof gameRequestSchema>;

/** ゲームへの答え。クイズは選んだ選択肢、数値予想は数（0〜100 の整数）、投票は選んだ人、合言葉は言葉、抽選は参加。どれか 1 つ */
export const gameAnswerRequestSchema = z
  .object({
    choiceId: idSchema.optional(),
    value: gameNumber.optional(),
    targetUserId: idSchema.optional(),
    text: keywordText.optional(),
    /** 抽選に参加する */
    entry: z.literal(true).optional(),
  })
  .refine((v) => [v.choiceId, v.value, v.targetUserId, v.text, v.entry].filter((x) => x !== undefined).length === 1, {
    message: "選択肢・数・選んだ人・言葉・参加のどれか 1 つを送ってください",
  });
