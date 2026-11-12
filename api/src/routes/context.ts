import { randomBytes, randomInt } from "node:crypto";
import {
  formatDisplayName,
  hasGameAnswers,
  type PhotoDto,
  type PrizeDto,
  type RandomInt,
  type Settings,
} from "@partally/shared";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { ulid } from "ulid";
import { toParticipantUserDto, toUserDto, type VisiblePhoto } from "../dto.js";
import { type Env, fail } from "../http.js";
import { type PhotoStorage, photoPath, prizeImagePath } from "../photo-storage.js";
import type { FavoriteRecord, GameRecord, PhotoRecord, PrizeRecord, Repository, UserRecord } from "../repository.js";
import {
  buildRanking,
  type GameStats,
  type GameWithAnswers,
  gameStatsByUser,
  NO_GAME_STATS,
  withAnswers,
} from "../scoring.js";
import {
  ADMIN_SESSION_MAX_AGE,
  type AdminSession,
  sign,
  USER_SESSION_MAX_AGE,
  type UserSession,
  verify,
} from "../session.js";
import type { UrlSigner } from "../url-signer.js";

export interface AppDeps {
  repo: Repository;
  storage: PhotoStorage;
  signer: UrlSigner;
  sessionSecret: string;
  adminPassword: string;
  /** ローカル開発（http）では false にする */
  secureCookies: boolean;
  now?: () => Date;
  randomInt?: RandomInt;
  newId?: () => string;
  newToken?: () => string;
  /** 結果整合の読み取りを待つ間（抽選の確定で、参加者を読み直す前に待つ）。テストでは待たない */
  settle?: () => Promise<void>;
}

export const USER_COOKIE = "session";
export const ADMIN_COOKIE = "admin_session";
export const ADMIN_COOKIE_PATH = "/api/admin";
const PHOTO_COOKIE_PATH = "/photos/approved/";
/** 公開済み写真を見るための CloudFront 署名付き Cookie の有効期間 */
const PHOTO_COOKIE_TTL_MS = 12 * 60 * 60 * 1000;
/** 検閲待ち写真・管理画面の署名付き URL の有効期間。画面は一覧の取り直しで URL を更新する */
const SIGNED_URL_TTL_MS = 60 * 60 * 1000;
/** 結果整合の索引（GSI）に、直前の書き込みが出るまで待つ間（通常は 1 秒もかからない） */
const SETTLE_MS = 1000;
/** ランキングで公開中の写真をまとめて読むときの 1 回の件数 */
const RANKING_PHOTO_PAGE_SIZE = 100;
/** ランキングで写真ごとのお気に入りを同時に読む数 */
const RANKING_FAVORITE_CONCURRENCY = 10;

/** API の処理の間で共有する依存と部品 */
export function createContext(deps: AppDeps) {
  const {
    repo,
    storage,
    signer,
    sessionSecret,
    adminPassword,
    secureCookies,
    now = () => new Date(),
    randomInt: rand = (max) => randomInt(max),
    newId = () => ulid(),
    newToken = () => randomBytes(16).toString("base64url"),
    settle = () => new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS)),
  } = deps;
  const nowSeconds = () => Math.floor(now().getTime() / 1000);

  const setUserSession = (c: Context, user: UserRecord & { token: string }) => {
    const session: UserSession = { uid: user.userId, tok: user.token, iat: nowSeconds() };
    setCookie(c, USER_COOKIE, sign(session, sessionSecret), {
      httpOnly: true,
      secure: secureCookies,
      sameSite: "Lax",
      path: "/",
      maxAge: USER_SESSION_MAX_AGE,
    });
    setPhotoCookies(c);
  };

  const setPhotoCookies = (c: Context) => {
    const cookies = signer.approvedCookies(new Date(now().getTime() + PHOTO_COOKIE_TTL_MS));
    for (const [name, value] of Object.entries(cookies)) {
      setCookie(c, name, value, {
        httpOnly: true,
        secure: secureCookies,
        sameSite: "Lax",
        path: PHOTO_COOKIE_PATH,
        maxAge: PHOTO_COOKIE_TTL_MS / 1000,
      });
    }
  };

  /**
   * 公開済み写真は Cookie で、検閲待ち（と signAll 指定時はすべて）は署名付き URL で見せる。
   * favorites を渡すと、その中にある写真に favorited を付ける（参加者の一覧用）
   */
  const toPhotoDto = (
    photo: VisiblePhoto,
    users: Map<string, UserRecord>,
    options: { signAll?: boolean; favorites?: Set<string>; hideCounts?: boolean } = {},
  ): PhotoDto => {
    const { signAll = false, favorites, hideCounts = false } = options;
    const uploader = users.get(photo.uploaderId);
    const dto: PhotoDto = {
      photoId: photo.photoId,
      uploaderId: photo.uploaderId,
      uploaderName: uploader ? formatDisplayName(uploader.epithet, uploader.name) : undefined,
      status: photo.status,
      favoriteCount: hideCounts ? undefined : photo.favoriteCount,
      favorited: favorites ? favorites.has(photo.photoId) : undefined,
      createdAt: photo.createdAt,
      reviewedAt: photo.reviewedAt,
    };
    if (photo.status === "rejected") return dto;
    const area = photo.status === "approved" ? "approved" : "pending";
    const expiresAt = new Date(now().getTime() + SIGNED_URL_TTL_MS);
    const url = (kind: "thumb" | "full") =>
      area === "approved" && !signAll
        ? photoPath(area, photo.photoId, kind)
        : signer.signPath(photoPath(area, photo.photoId, kind), expiresAt);
    return { ...dto, thumbUrl: url("thumb"), fullUrl: url("full") };
  };

  /**
   * 景品・ゲームの画像は管理画面でも参加者の画面でも署名付き URL で渡す。期限を 1 時間ごとの区切りにそろえ、
   * 同じ時間帯は同じ URL にして、ブラウザが持っている画像を確かめるだけで使えるようにする（期限までは 1〜2 時間残る）
   */
  const imageUrls = new Map<string, string>();
  const imageUrlOf = (imageId: string | undefined): string | undefined => {
    if (!imageId) return undefined;
    const expiresAt = (Math.floor(now().getTime() / SIGNED_URL_TTL_MS) + 2) * SIGNED_URL_TTL_MS;
    // 参加者のゲームの画面は数秒ごとに読み直すので、同じ期限の URL は作り直さない（署名の計算を減らす）
    const key = `${imageId}@${expiresAt}`;
    let url = imageUrls.get(key);
    if (!url) {
      if (imageUrls.size > 1000) imageUrls.clear();
      url = signer.signPath(prizeImagePath(imageId), new Date(expiresAt));
      imageUrls.set(key, url);
    }
    return url;
  };

  const toPrizeDto = (prize: PrizeRecord): PrizeDto => ({
    prizeId: prize.prizeId,
    name: prize.name,
    quantity: prize.quantity,
    positions: prize.positions,
    imageId: prize.imageId,
    imageUrl: imageUrlOf(prize.imageId),
    createdAt: prize.createdAt,
  });

  /** 一覧に出てくるアップロード者だけを取得する */
  const uploadersOf = async (photos: PhotoRecord[]) =>
    new Map((await repo.getUsers(photos.map((p) => p.uploaderId))).map((u) => [u.userId, u]));

  /**
   * 1 人分のゲームの点数。クイズ形式は自分の答えだけを読む。
   * 数値予想・合言葉は順位が他の人の答えで決まるので、自分が答えた確定済みのものだけ全員の答えを読む。
   * 投票は自分が投票していなくても選ばれていることがあるので、確定済みのものは全員の票を読む
   */
  const scoresOf = async (userId: string): Promise<GameStats> => {
    const [games, mine] = await Promise.all([repo.listGames(), repo.listGameAnswersByUser(userId)]);
    const answered = new Set(mine.map((a) => a.gameId));
    const needsAll = (game: GameRecord) =>
      game.status === "confirmed" &&
      (game.format === "vote" ||
        ((game.format === "number" || game.format === "keyword") && answered.has(game.gameId)));
    const entries = await Promise.all(
      withAnswers(games, mine).map(async (entry) =>
        needsAll(entry.game)
          ? { game: entry.game, answers: await repo.listGameAnswersByGame(entry.game.gameId) }
          : entry,
      ),
    );
    return gameStatsByUser(entries).get(userId) ?? NO_GAME_STATS;
  };

  /** 全ゲームと、クイズ・数値予想・投票の答え（ゲームは数十程度の想定なので、ゲームごとに並行して読む） */
  const gamesWithAnswers = async (): Promise<GameWithAnswers[]> => {
    const games = await repo.listGames();
    const answers = await Promise.all(
      games.map((g) => (hasGameAnswers(g) ? repo.listGameAnswersByGame(g.gameId) : Promise.resolve([]))),
    );
    return games.map((game, i) => ({ game, answers: answers[i]! }));
  };

  const listAllApprovedPhotos = async () => {
    const photos: PhotoRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await repo.listPhotosByStatus("approved", RANKING_PHOTO_PAGE_SIZE, cursor);
      photos.push(...page.items);
      cursor = page.cursor;
    } while (cursor);
    return photos;
  };

  /** 全員分のゲームの点数（管理画面のユーザ一覧用） */
  const scoresOfAll = async () => {
    const stats = gameStatsByUser(await gamesWithAnswers());
    return (userId: string) => stats.get(userId) ?? NO_GAME_STATS;
  };

  /** ユーザ情報を、設定とゲームの成績を添えて参加者向けに返す */
  const participantUser = async (user: UserRecord, settings?: Settings) => {
    const [resolved, scores] = await Promise.all([settings ?? repo.getSettings(), scoresOf(user.userId)]);
    return toParticipantUserDto(user, resolved, scores);
  };

  const adminUser = async (user: UserRecord) => {
    const [settings, scores] = await Promise.all([repo.getSettings(), scoresOf(user.userId)]);
    return toUserDto(user, settings, scores);
  };

  /** 管理者の API（/admin/*）の認証。ログイン・ログアウトだけは通す */
  const requireAdmin = async (c: Context<Env>, next: () => Promise<void>) => {
    if (c.req.path === `${ADMIN_COOKIE_PATH}/login` || c.req.path === `${ADMIN_COOKIE_PATH}/logout`) {
      return next();
    }
    const session = verify<AdminSession>(
      getCookie(c, ADMIN_COOKIE),
      sessionSecret,
      ADMIN_SESSION_MAX_AGE,
      nowSeconds(),
    );
    if (!session?.adm) return fail(c, 401, "unauthorized");
    await next();
  };

  const requireUser = async (c: Context<Env>, next: () => Promise<void>) => {
    const session = verify<UserSession>(getCookie(c, USER_COOKIE), sessionSecret, USER_SESSION_MAX_AGE, nowSeconds());
    const user = session && (await repo.getUser(session.uid));
    if (!session || user?.status !== "active" || user.token !== session.tok) {
      deleteCookie(c, USER_COOKIE, { path: "/", secure: secureCookies });
      return fail(c, 401, "unauthorized");
    }
    c.set("user", user);
    await next();
  };

  /** ランキングと推移を今のデータから組み立てる（管理画面と参加者の画面で共通） */
  async function loadRanking(settings: Settings) {
    const [users, photos, games] = await Promise.all([repo.listUsers(), listAllApprovedPhotos(), gamesWithAnswers()]);
    // 選ばれていない写真は読まない
    const chosen = photos.filter((p) => p.favoriteCount > 0);
    const favorites: FavoriteRecord[] = [];
    for (let i = 0; i < chosen.length; i += RANKING_FAVORITE_CONCURRENCY) {
      const batch = chosen.slice(i, i + RANKING_FAVORITE_CONCURRENCY);
      for (const list of await Promise.all(batch.map((p) => repo.listFavoritesOfPhoto(p.photoId)))) {
        favorites.push(...list);
      }
    }
    return buildRanking({ users, settings, photos, favorites, games, now: now().toISOString() });
  }

  /** 使わなくなった画像を消す。景品・ゲームは保存できているので、消せなくても失敗にはしない（残った画像は Reset で消える） */
  const removePrizeImage = async (imageId: string) => {
    try {
      await storage.removePrizeImage(imageId);
    } catch (e) {
      console.error(`画像 ${imageId} の削除か、CloudFront のキャッシュの無効化に失敗しました`, e);
    }
  };

  return {
    repo,
    storage,
    sessionSecret,
    adminPassword,
    secureCookies,
    now,
    rand,
    newId,
    newToken,
    settle,
    nowSeconds,
    setUserSession,
    setPhotoCookies,
    toPhotoDto,
    imageUrlOf,
    toPrizeDto,
    uploadersOf,
    gamesWithAnswers,
    scoresOfAll,
    participantUser,
    adminUser,
    loadRanking,
    requireUser,
    requireAdmin,
    removePrizeImage,
  };
}

export type AppContext = ReturnType<typeof createContext>;
