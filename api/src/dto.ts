import {
  type CurrentGameDto,
  formatDisplayName,
  type GameDto,
  type PhotoStatus,
  type Rules,
  type ScheduleItemDto,
  type Settings,
  type TokenDto,
  type UserDto,
} from "@partally/shared";
import type {
  GameAnswerRecord,
  GameRecord,
  PhotoRecord,
  ScheduleItemRecord,
  TokenRecord,
  UserRecord,
} from "./repository.js";
import { calculatePoints, countedAnswers, type GameStats, isKeywordCorrect } from "./scoring.js";

/** 参加者・管理画面に出す写真（削除済みの記録は出さない） */
export type VisiblePhoto = PhotoRecord & { status: PhotoStatus };

export function isVisible(photo: PhotoRecord): photo is VisiblePhoto {
  return photo.status !== "deleted";
}

export function toUserDto(user: UserRecord, settings: Settings, game: GameStats): UserDto {
  return {
    userId: user.userId,
    name: user.name,
    epithet: user.epithet,
    displayName: formatDisplayName(user.epithet, user.name),
    status: user.status,
    uploadCount: user.uploadCount,
    approvedCount: user.approvedCount,
    favoritesGiven: user.favoritesGiven,
    favoritesReceived: user.favoritesReceived,
    gamePoints: game.points,
    points: calculatePoints(user, settings, game),
    createdAt: user.createdAt,
  };
}

/**
 * 参加者本人に返すユーザ情報。ポイントを伏せている間は、ポイントとその元になる選ばれた数を含めない。
 * ゲームの点数を伏せている間は、ゲームの点数と点数が入ったものを含めない
 */
export function toParticipantUserDto(user: UserRecord, settings: Settings, game: GameStats): UserDto {
  const { points, favoritesReceived, gamePoints, ...rest } = toUserDto(user, settings, game);
  return {
    ...rest,
    ...(settings.showPoints ? { points, favoritesReceived } : {}),
    ...(settings.showGamePoints ? { gamePoints, gameAwards: game.awards } : {}),
  };
}

export function toScheduleItemDto(item: ScheduleItemRecord): ScheduleItemDto {
  return {
    itemId: item.itemId,
    title: item.title,
    detail: item.detail,
    startMinute: item.startMinute,
    durationMinutes: item.durationMinutes,
  };
}

/** 開始時刻の早い順（同じなら作った順） */
export function sortSchedule(items: ScheduleItemRecord[]): ScheduleItemDto[] {
  return [...items].sort((a, b) => a.startMinute - b.startMinute).map(toScheduleItemDto);
}

type ImageUrlOf = (imageId: string | undefined) => string | undefined;

export function toGameDto(game: GameRecord, allAnswers: GameAnswerRecord[], imageUrlOf: ImageUrlOf): GameDto {
  const answers = countedAnswers(game, allAnswers);
  const counts = new Map<string, number>();
  for (const a of answers) if (a.choiceId) counts.set(a.choiceId, (counts.get(a.choiceId) ?? 0) + 1);
  return {
    gameId: game.gameId,
    format: game.format,
    name: game.name,
    description: game.description,
    imageId: game.imageId,
    imageUrl: imageUrlOf(game.imageId),
    status: game.status,
    slots: game.slots.map((s) => ({ slotId: s.slotId, name: s.name, points: s.points, userIds: [...s.userIds] })),
    choices: game.choices.map((ch) => ({
      ...ch,
      imageUrl: imageUrlOf(ch.imageId),
      answerCount: counts.get(ch.choiceId) ?? 0,
    })),
    ranks: game.ranks.map((r) => ({ ...r })),
    correctNumber: game.correctNumber,
    voterPoints: game.voterPoints,
    keyword: game.keyword,
    drawOrder: game.drawOrder,
    answerCount: answers.length,
    storedAnswerCount: allAnswers.length,
    createdAt: game.createdAt,
    openedAt: game.openedAt,
    updatedAt: game.updatedAt,
    confirmedAt: game.confirmedAt,
  };
}

/** 参加者に返す開催中のゲーム。点数（何をしたら何点か）・正解・合言葉・誰がどの枠に入ったかは含めない（CurrentGameDto） */
export function toCurrentGameDto(
  game: GameRecord,
  answer: Pick<GameAnswerRecord, "choiceId" | "value" | "targetUserId" | "text" | "entry"> | undefined,
  imageUrlOf: ImageUrlOf,
): CurrentGameDto {
  return {
    gameId: game.gameId,
    format: game.format,
    name: game.name,
    description: game.description,
    imageUrl: imageUrlOf(game.imageId),
    choices: game.choices.map(({ choiceId, text, imageId }) => ({ choiceId, text, imageUrl: imageUrlOf(imageId) })),
    myChoiceId: answer?.choiceId,
    myValue: answer?.value,
    myTargetUserId: answer?.targetUserId,
    // 合言葉そのものは返さず、正解したかだけ返す
    myKeywordCorrect: game.format === "keyword" ? isKeywordCorrect(game, answer?.text) : undefined,
    myEntry: game.format === "lottery" ? answer?.entry === true : undefined,
  };
}

export function toRules(settings: Settings): Rules {
  const { moderation: _moderation, ...rules } = settings;
  return rules;
}

export function toTokenDto(token: TokenRecord, user?: UserRecord): TokenDto {
  return {
    token: token.token,
    label: token.label,
    status: token.status,
    userId: token.userId,
    displayName: user ? formatDisplayName(user.epithet, user.name) : undefined,
    createdAt: token.createdAt,
    boundAt: token.boundAt,
  };
}
