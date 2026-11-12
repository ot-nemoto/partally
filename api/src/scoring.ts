import {
  formatDisplayName,
  formatRankRange,
  type GameAwardDto,
  type GameFormat,
  normalizeKeyword,
  type ParticipantRankingResponse,
  type PointKey,
  type RankingEntryDto,
  type RankingPointDto,
  type RankingResponse,
  rankNumberAnswers,
  rankRangeOf,
  type Settings,
  tallyVotes,
} from "@partally/shared";
import type { FavoriteRecord, GameAnswerRecord, GameRecord, PhotoRecord, UserRecord } from "./repository.js";

/** ゲームと、クイズ形式の答え（結果入力形式では空） */
export interface GameWithAnswers {
  game: GameRecord;
  answers: GameAnswerRecord[];
}

/** ゲームを、そのゲームに答えた分だけと組にする（1 人分の答えから点数を数えるとき） */
export function withAnswers(games: GameRecord[], answers: GameAnswerRecord[]): GameWithAnswers[] {
  return games.map((game) => ({ game, answers: answers.filter((a) => a.gameId === game.gameId) }));
}

export interface GameStats {
  /** 確定したゲームで入った点数の合計 */
  points: number;
  /** 点数が入ったもの（確定した順） */
  awards: GameAwardDto[];
}

export const NO_GAME_STATS: GameStats = { points: 0, awards: [] };

interface GameAward extends GameAwardDto {
  userId: string;
  /** 確定した時刻（推移ではこの時刻に入る） */
  at: string;
}

/** 形式ごとの点数の付け方で、1 件ごとに返すもの（確定した時刻とゲームの名前は gameAwards で付ける） */
type FormatAward = Omit<GameAward, "at" | "gameName">;

/**
 * 形式ごとの点数の数え方。形式の共通の決まり（答えに使う項目・順位の単位）は @partally/shared の GAME_FORMAT_RULES
 */
interface GameScoring {
  /** 確定したゲームで、誰に何点入るか。answers は数える答え（countedAnswers）だけ */
  awards: (game: GameRecord, answers: GameAnswerRecord[]) => FormatAward[];
  /**
   * 1 人分の点数を出すのに、全員の答えを読むか。順位が他の人の答えで決まる形式は、自分が答えたときだけ読む（answered）。
   * 投票は自分が投票していなくても選ばれていることがあるので、いつも読む（always）
   */
  readsAllAnswers: "never" | "answered" | "always";
  /** 数える答えか（確定より後に届いた答えは、形式によらず countedAnswers で除く） */
  counts?: (game: GameRecord, answer: GameAnswerRecord) => boolean;
}

export const GAME_SCORING: Record<GameFormat, GameScoring> = {
  // 枠に入った人に枠の点数
  result: {
    readsAllAnswers: "never",
    awards: (game) =>
      game.slots.flatMap((slot) =>
        slot.userIds.map((userId) => ({ userId, slotName: slot.name, points: slot.points })),
      ),
  },
  // 選んだ選択肢の点数
  quiz: {
    readsAllAnswers: "never",
    awards: (game, answers) => {
      const choices = new Map(game.choices.map((ch) => [ch.choiceId, ch]));
      return answers.flatMap((answer) => {
        const choice = answer.choiceId === undefined ? undefined : choices.get(answer.choiceId);
        return choice ? [{ userId: answer.userId, slotName: choice.text, points: choice.points }] : [];
      });
    },
  },
  // 正解に近い順の順位が入る範囲の点数
  number: {
    readsAllAnswers: "answered",
    awards: (game, answers) => {
      if (game.correctNumber === undefined) return [];
      const counted = answers.filter((a): a is GameAnswerRecord & { value: number } => a.value !== undefined);
      const results = rankNumberAnswers(
        counted.map((a) => a.value),
        game.correctNumber,
        game.ranks,
      );
      return counted.map((answer, i) => {
        const { rank, points } = results[i]!;
        return { userId: answer.userId, slotName: `${rank} 位（予想 ${answer.value}）`, points };
      });
    },
  },
  // 得票の順位が入る範囲の点数（選ばれた人）と、投票した人の点数
  vote: {
    readsAllAnswers: "always",
    awards: (game, answers) => {
      const counted = answers.filter(
        (a): a is GameAnswerRecord & { targetUserId: string } => a.targetUserId !== undefined,
      );
      const voted: FormatAward[] = tallyVotes(
        counted.map((a) => a.targetUserId),
        game.ranks,
      ).map(({ userId, votes, rank, points }) => ({ userId, slotName: `${rank} 位（${votes} 票）`, points }));
      const voters: FormatAward[] =
        game.voterPoints > 0
          ? counted.map((answer) => ({ userId: answer.userId, slotName: "投票", points: game.voterPoints }))
          : [];
      return [...voted, ...voters];
    },
  },
  // 正解した順が入る範囲の点数。今の合言葉に合う答えだけを数える
  keyword: {
    readsAllAnswers: "answered",
    counts: (game, answer) => isKeywordCorrect(game, answer.text),
    awards: (game, answers) =>
      // 正解した時刻の順に並べる（同じ時刻は userId の順）
      answers
        .slice()
        .sort((a, b) => a.answeredAt.localeCompare(b.answeredAt) || a.userId.localeCompare(b.userId))
        .map((answer, i) => ({
          userId: answer.userId,
          slotName: `${i + 1} 番目に正解`,
          points: rankRangeOf(game.ranks, i + 1)?.points ?? 0,
        })),
  },
  // 確定したときに決めた順番で、範囲に入った人に点数。確定したら、抽選に入った人（drawOrder）だけを数える
  lottery: {
    readsAllAnswers: "never",
    counts: (game, answer) => !game.drawOrder || game.drawOrder.includes(answer.userId),
    awards: (game) =>
      (game.drawOrder ?? []).flatMap((userId, i) => {
        const range = rankRangeOf(game.ranks, i + 1);
        return range ? [{ userId, slotName: `${formatRankRange(range, "等")}に当選`, points: range.points }] : [];
      }),
  },
};

/**
 * 確定したゲームで、誰に何点入ったか（確定した順）。下書き・開催中のゲームは数えない
 * （クイズを選び直して、点数の変化から正解が分からないように）。
 * 結果入力は枠に入った人に枠の点数、クイズは選んだ選択肢の点数、数値予想は正解に近い順の順位が入る範囲の点数、
 * 投票は得票の順位が入る範囲の点数（選ばれた人）と、投票した人の点数、合言葉は正解した順が入る範囲の点数、
 * 抽選は確定したときに決めた順番が入る範囲の点数。確定の直前に受け付けて確定の後に保存された答え
 * （answeredAt > confirmedAt）は数えない
 */
export function gameAwards(entries: GameWithAnswers[]): GameAward[] {
  const awards: GameAward[] = [];
  const confirmed = entries
    .filter(
      (e): e is GameWithAnswers & { game: { confirmedAt: string } } =>
        e.game.status === "confirmed" && !!e.game.confirmedAt,
    )
    .sort((a, b) => a.game.confirmedAt.localeCompare(b.game.confirmedAt));
  for (const { game, answers: all } of confirmed) {
    // 数える答え（確定より後に届いた答えと、今の合言葉に合わない答えを除く）。管理画面の回答数と同じ数え方
    const answers = countedAnswers(game, all);
    for (const award of GAME_SCORING[game.format].awards(game, answers)) {
      awards.push({ ...award, at: game.confirmedAt, gameName: game.name });
    }
  }
  return awards;
}

/** 全員分のゲームの点数と、点数が入ったもの */
export function gameStatsByUser(entries: GameWithAnswers[]): Map<string, GameStats> {
  const byUser = new Map<string, GameStats>();
  for (const { userId, at: _at, ...award } of gameAwards(entries)) {
    const stats = byUser.get(userId) ?? { points: 0, awards: [] };
    stats.points += award.points;
    stats.awards.push(award);
    byUser.set(userId, stats);
  }
  return byUser;
}

function appendTo<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** 項目ごとのポイント。同じポイントのときの順位の決め方（tieBreakOrder）でも使う */
function pointsByKey(user: UserRecord, settings: Settings, game: GameStats): Record<PointKey, number> {
  return {
    upload: user.approvedCount * settings.uploadPoints,
    favoriteGiven: user.favoritesGiven * settings.favoriteGivenPoints,
    favoriteReceived: user.favoritesReceived * settings.favoritePoints,
    game: game.points,
  };
}

/** ポイントは保存せず、現在の設定で毎回計算する（設定を変えると全員に同じ基準で反映される） */
export function calculatePoints(user: UserRecord, settings: Settings, game: GameStats = NO_GAME_STATS): number {
  return sumPoints(pointsByKey(user, settings, game));
}

function sumPoints(byKey: Record<PointKey, number>): number {
  return Object.values(byKey).reduce((sum, p) => sum + p, 0);
}

export interface RankingSource {
  users: UserRecord[];
  settings: Settings;
  /** 公開中の写真 */
  photos: PhotoRecord[];
  /** 公開中の写真へのお気に入り */
  favorites: FavoriteRecord[];
  /** ゲームとクイズ形式の答え（確定したものだけを数える） */
  games?: GameWithAnswers[];
  now: string;
}

/**
 * ランキングと累計ポイントの推移を作る。ポイントは保存していないので、今残っているデータから
 * 時刻つきの出来事（写真の公開・お気に入りに選ばれた・お気に入りを選んだ・ゲームの確定）を組み立て、現在の設定で数える。
 * 削除した写真や外したお気に入りは含めないので、推移の最後はユーザ管理と同じポイントになる
 * （GSI の反映待ちでずれることがあるため、最後の点は calculatePoints の値にそろえる）
 */
export function buildRanking(source: RankingSource): RankingResponse {
  const { users, settings, photos, favorites, games = [], now } = source;
  const events = new Map<string, { at: string; points: number }[]>();
  const add = (userId: string, at: string, points: number | undefined) => {
    if (points) appendTo(events, userId, { at, points });
  };

  const photosById = new Map(photos.map((p) => [p.photoId, p]));
  // 事前確認では承認した時刻、事後確認では投稿した時刻に公開される
  for (const photo of photos) add(photo.uploaderId, photo.reviewedAt ?? photo.createdAt, settings.uploadPoints);
  for (const favorite of favorites) {
    const photo = photosById.get(favorite.photoId);
    // 公開中の写真へのお気に入りだけを、選ばれた人と選んだ人（選んだ時刻）の両方に数える
    if (photo) {
      add(photo.uploaderId, favorite.createdAt, settings.favoritePoints);
      add(favorite.userId, favorite.createdAt, settings.favoriteGivenPoints);
    }
  }
  // ゲームの点数は確定した時刻に入る（gameStatsByUser と同じ gameAwards で数える）
  for (const award of gameAwards(games)) add(award.userId, award.at, award.points);

  const gameStats = gameStatsByUser(games);

  const entries = users.map((user) => {
    const byKey = pointsByKey(user, settings, gameStats.get(user.userId) ?? NO_GAME_STATS);
    const points = sumPoints(byKey);
    const history: RankingPointDto[] = [{ at: user.createdAt, points: 0 }];
    let total = 0;
    for (const event of (events.get(user.userId) ?? []).sort((a, b) => a.at.localeCompare(b.at))) {
      total += event.points;
      const last = history[history.length - 1]!;
      // 登録時の 0 は残す（登録と同じ時刻の出来事でも、0 から上がる線にする）
      if (history.length > 1 && last.at === event.at) last.points = total;
      else history.push({ at: event.at, points: total });
    }
    history.push({ at: now, points });
    return { user, points, byKey, history };
  });

  // ポイントの高い順。同点は設定の優先順に比べる（ポイントの項目は多い人、登録順は先に登録した人を上）。
  // 順位は必ず分ける。優先順で決まらないとき（登録時刻まで同じ）も、ユーザ ID の順で並べて別の順位にする
  const compareTie = (a: (typeof entries)[number], b: (typeof entries)[number]) => {
    for (const key of settings.tieBreakOrder) {
      const diff =
        key === "registered" ? a.user.createdAt.localeCompare(b.user.createdAt) : b.byKey[key] - a.byKey[key];
      if (diff !== 0) return diff;
    }
    return 0;
  };
  entries.sort(
    (a, b) =>
      b.points - a.points ||
      compareTie(a, b) ||
      a.user.createdAt.localeCompare(b.user.createdAt) ||
      a.user.userId.localeCompare(b.user.userId),
  );
  const ranking: RankingEntryDto[] = [];
  entries.forEach((entry, i) => {
    ranking.push({
      rank: i + 1,
      userId: entry.user.userId,
      name: entry.user.name,
      epithet: entry.user.epithet,
      displayName: formatDisplayName(entry.user.epithet, entry.user.name),
      status: entry.user.status,
      points: entry.points,
      history: entry.history,
    });
  });
  return { ranking, generatedAt: now };
}

/** 名前を伏せたときの名前・称号 */
export const HIDDEN_NAME = "???";

/**
 * 参加者に返すランキング・推移。紐づけを解除した人は除き、並び順のとおりに 1 位から順位を付け直す。
 * 名前を伏せるときは名前・称号・ユーザ ID を返さず（ID は順番の番号に置き換える）、
 * 登録した時刻から人が分からないよう、推移の始まり（登録時の 0）を全員そろえる。
 * ポイントを伏せるときは、最大値を 100 とした割合（小数第 1 位まで）に置き換える
 */
export function toParticipantRanking(
  ranking: RankingResponse,
  hideNames: boolean,
  hidePoints: boolean,
): ParticipantRankingResponse {
  const entries = ranking.ranking.filter((e) => e.status !== "unbound");
  let max = 0;
  let start = ranking.generatedAt;
  for (const e of entries) {
    max = Math.max(max, e.points);
    for (const h of e.history) max = Math.max(max, h.points);
    const joined = e.history[0]?.at;
    if (joined && joined < start) start = joined;
  }
  const scale = (points: number) => (hidePoints ? (max > 0 ? Math.round((points / max) * 1000) / 10 : 0) : points);
  const result: RankingEntryDto[] = [];
  entries.forEach((e, i) => {
    result.push({
      ...e,
      rank: i + 1,
      ...(hideNames ? { userId: `r${i + 1}`, name: HIDDEN_NAME, epithet: HIDDEN_NAME, displayName: HIDDEN_NAME } : {}),
      points: scale(e.points),
      history: e.history.map((h, j) => ({ at: hideNames && j === 0 ? start : h.at, points: scale(h.points) })),
    });
  });
  return { generatedAt: ranking.generatedAt, hideNames, hidePoints, ranking: result };
}

/** 合言葉に合っているか（表記の揺れは normalizeKeyword でなくす）。合言葉が無ければ合わない */
export function isKeywordCorrect(game: Pick<GameRecord, "keyword">, text: string | undefined): boolean {
  return game.keyword !== undefined && text !== undefined && normalizeKeyword(text) === normalizeKeyword(game.keyword);
}

/**
 * 数える答え。点数の計算（gameAwards）と管理画面の回答数で共通。確定したゲームでは確定より後に届いた答えを除き、
 * 合言葉は今の合言葉に合う答えだけ、確定した抽選は抽選に入った人だけを数える
 */
export function countedAnswers(game: GameRecord, answers: GameAnswerRecord[]): GameAnswerRecord[] {
  const at = game.status === "confirmed" ? game.confirmedAt : undefined;
  const counts = GAME_SCORING[game.format].counts;
  return answers.filter((a) => (at === undefined || a.answeredAt <= at) && (counts?.(game, a) ?? true));
}
