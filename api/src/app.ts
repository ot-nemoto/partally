import { randomBytes, randomInt } from "node:crypto";
import {
  type ApiErrorCode,
  adminLoginRequestSchema,
  type CurrentGameDto,
  formatDisplayName,
  formatRankRange,
  type GameAwardDto,
  type GameDto,
  type GameRequest,
  gameAnswerRequestSchema,
  gameConfirmProblem,
  gameRequestSchema,
  hasGameAnswers,
  issueTokensRequestSchema,
  normalizeKeyword,
  type ParticipantRankingResponse,
  type PhotoDto,
  type PhotoStatus,
  type PointKey,
  type PrizeDto,
  photoStatusSchema,
  prizeRequestSchema,
  qrLoginRequestSchema,
  type RandomInt,
  type RankingEntryDto,
  type RankingPointDto,
  type RankingResponse,
  type Rules,
  randomEpithet,
  rankNumberAnswers,
  registerRequestSchema,
  type ScheduleItemDto,
  type Settings,
  scheduleItemRequestSchema,
  shuffle,
  type TokenDto,
  tallyVotes,
  type UserDto,
  updateSettingsRequestSchema,
  updateUserRequestSchema,
} from "@partally/shared";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ulid } from "ulid";
import type { z } from "zod";
import { type PhotoStorage, photoPath, prizeImagePath } from "./photo-storage.js";
import {
  EpithetTakenError,
  FavoriteLimitError,
  type FavoriteRecord,
  GameAlreadyOpenError,
  type GameAnswerRecord,
  type GameChoice,
  type GameRank,
  type GameRecord,
  type GameSlot,
  InvalidStateError,
  NotFoundError,
  type PhotoRecord,
  type PrizeRecord,
  type Repository,
  type ScheduleItemRecord,
  TokenNotAvailableError,
  type TokenRecord,
  type UserRecord,
} from "./repository.js";
import {
  ADMIN_SESSION_MAX_AGE,
  type AdminSession,
  safeEqual,
  sign,
  USER_SESSION_MAX_AGE,
  type UserSession,
  verify,
} from "./session.js";
import type { UrlSigner } from "./url-signer.js";

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

type Env = { Variables: { user: UserRecord } };

const USER_COOKIE = "session";
const ADMIN_COOKIE = "admin_session";
const ADMIN_COOKIE_PATH = "/api/admin";
const EPITHET_ATTEMPTS = 10;
const PHOTO_COOKIE_PATH = "/photos/approved/";
/** 公開済み写真を見るための CloudFront 署名付き Cookie の有効期間 */
const PHOTO_COOKIE_TTL_MS = 12 * 60 * 60 * 1000;
/** 検閲待ち写真・管理画面の署名付き URL の有効期間。画面は一覧の取り直しで URL を更新する */
const SIGNED_URL_TTL_MS = 60 * 60 * 1000;
const PHOTO_PAGE_SIZE = 30;
/** 結果整合の索引（GSI）に、直前の書き込みが出るまで待つ間（通常は 1 秒もかからない） */
const SETTLE_MS = 1000;
const GAME_CONFLICT_MESSAGE = "ほかの画面でこのゲームが変更されました。開き直してから直してください";
/** ランキングで公開中の写真をまとめて読むときの 1 回の件数 */
const RANKING_PHOTO_PAGE_SIZE = 100;
/** ランキングで写真ごとのお気に入りを同時に読む数 */
const RANKING_FAVORITE_CONCURRENCY = 10;

export function createApp(deps: AppDeps) {
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

  const app = new Hono<Env>().basePath("/api");

  app.onError((err, c) => {
    console.error(err);
    return fail(c, 500, "internal_error");
  });
  app.notFound((c) => fail(c, 404, "not_found"));

  // 更新系は JSON に限定する。クロスオリジンからの JSON 送信はプリフライトが必要になるため CSRF 対策になる
  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const type = c.req.header("content-type") ?? "";
      if (!type.startsWith("application/json")) {
        return fail(c, 415, "bad_request", "Content-Type は application/json にしてください");
      }
    }
    await next();
  });

  // ---- 参加者 ----

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

  app.post("/auth/qr", async (c) => {
    const body = await parseBody(c, qrLoginRequestSchema);
    if (!body.ok) return body.response;

    const token = await repo.getToken(body.data.token);
    if (!token) return fail(c, 404, "invalid_token");
    if (token.status === "unbound" || !token.userId) return c.json({ status: "unbound" as const });

    const user = await repo.getUser(token.userId);
    if (user?.status !== "active" || user.token !== token.token) {
      // トークンとユーザの状態が食い違っている。管理者に紐づけ解除してもらう必要がある
      return fail(c, 404, "invalid_token");
    }
    setUserSession(c, { ...user, token: token.token });
    return c.json({ status: "bound" as const, user: await participantUser(user) });
  });

  app.post("/auth/register", async (c) => {
    const body = await parseBody(c, registerRequestSchema);
    if (!body.ok) return body.response;
    const { token, name } = body.data;

    const existing = await repo.getToken(token);
    if (!existing) return fail(c, 404, "invalid_token");
    if (existing.status !== "unbound") return fail(c, 409, "token_already_bound");

    const timestamp = now().toISOString();
    const userId = newId();
    for (let attempt = 0; attempt < EPITHET_ATTEMPTS; attempt++) {
      const user: UserRecord & { token: string } = {
        userId,
        name,
        epithet: randomEpithet(rand),
        token,
        status: "active",
        uploadCount: 0,
        approvedCount: 0,
        favoritesGiven: 0,
        favoritesReceived: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      try {
        await repo.registerUser(user);
      } catch (e) {
        if (e instanceof EpithetTakenError) continue;
        if (e instanceof TokenNotAvailableError) return fail(c, 409, "token_already_bound");
        throw e;
      }
      setUserSession(c, user);
      return c.json({ user: await participantUser(user) }, 201);
    }
    throw new Error(`二つ名を ${EPITHET_ATTEMPTS} 回抽選しても空きが見つかりませんでした`);
  });

  app.post("/auth/logout", (c) => {
    deleteCookie(c, USER_COOKIE, { path: "/", secure: secureCookies });
    return c.json({});
  });

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

  // 参加者に見せるランキング・推移。見せない設定のときは無いものとして扱う。
  // 合計・順位は写真・お気に入り・ゲームのすべてのポイントで出す（ホーム画面の表示設定とは別）
  app.get("/ranking", requireUser, async (c) => {
    const settings = await repo.getSettings();
    if (!settings.rankingVisible) return fail(c, 404, "not_found");
    const ranking = await loadRanking(settings);
    // 横棒だけなので推移は返さない
    const entries = ranking.ranking.map((e) => ({ ...e, history: [] }));
    return c.json(
      toParticipantRanking({ ...ranking, ranking: entries }, settings.rankingHideNames, settings.rankingHidePoints),
    );
  });

  app.get("/trend", requireUser, async (c) => {
    const settings = await repo.getSettings();
    if (!settings.trendVisible) return fail(c, 404, "not_found");
    return c.json(toParticipantRanking(await loadRanking(settings), settings.trendHideNames, settings.trendHidePoints));
  });

  // 参加者に見せる景品。見せない設定のときは無いものとして扱う
  app.get("/prizes", requireUser, async (c) => {
    const settings = await repo.getSettings();
    if (!settings.prizesVisible) return fail(c, 404, "not_found");
    return c.json({ prizes: (await repo.listPrizes()).map(toPrizeDto) });
  });

  // 参加者に見せるスケジュール。見せない設定のときは無いものとして扱う
  app.get("/schedule", requireUser, async (c) => {
    const settings = await repo.getSettings();
    if (!settings.scheduleVisible) return fail(c, 404, "not_found");
    return c.json({ items: sortSchedule(await repo.listScheduleItems()), date: settings.scheduleDate });
  });

  app.get("/me", requireUser, async (c) => {
    // 写真用の署名付き Cookie は有効期間が短いので、アプリを開くたびに更新する
    setPhotoCookies(c);
    const settings = await repo.getSettings();
    return c.json({ user: await participantUser(c.get("user"), settings), rules: toRules(settings) });
  });

  // 参加者の画面が数秒ごとに呼ぶので、読み込みは最小限にする
  app.get("/game/current", requireUser, async (c) => {
    const gameId = await repo.getOpenGameId();
    const game = gameId ? await repo.getGame(gameId) : undefined;
    if (game?.status !== "open") return c.json({ game: null });
    const answer = hasGameAnswers(game) ? await repo.getGameAnswer(c.get("user").userId, game.gameId) : undefined;
    return c.json({ game: toCurrentGameDto(game, answer, imageUrlOf) });
  });

  app.put("/game/:gameId/answer", requireUser, async (c) => {
    const body = await parseBody(c, gameAnswerRequestSchema);
    if (!body.ok) return body.response;
    const game = await repo.getGame(c.req.param("gameId") ?? "");
    if (!game) return fail(c, 404, "not_found");
    const { choiceId, value, targetUserId, text, entry } = body.data;
    const userId = c.get("user").userId;
    // クイズは選択肢、数値予想は数、投票は人で答える（形式に合わない答えや、結果入力への答えは受け付けない）
    const fits =
      game.format === "quiz"
        ? choiceId !== undefined
        : game.format === "number"
          ? value !== undefined
          : game.format === "vote"
            ? targetUserId !== undefined
            : game.format === "keyword"
              ? text !== undefined
              : game.format === "lottery" && entry !== undefined;
    if (!fits) return fail(c, 400, "bad_request", "このゲームには、その形では答えられません");
    if (game.status !== "open") return fail(c, 409, "game_closed");
    if (choiceId !== undefined && !game.choices.some((ch) => ch.choiceId === choiceId)) {
      return fail(c, 400, "bad_request", "選択肢がありません");
    }
    if (targetUserId !== undefined) {
      if (targetUserId === userId) return fail(c, 400, "bad_request", "自分には投票できません");
      const target = await repo.getUser(targetUserId);
      if (target?.status !== "active") return fail(c, 400, "bad_request", "その人には投票できません");
    }
    if (text !== undefined) {
      // 合言葉は正解したときだけ保存する（不正解は何度でも試せる）。正解した後は、最初に正解した時刻のまま
      // 続けて送られても先の正解の時刻を上書きしないよう、強い整合性で読み、読んだときのままなら保存する
      const correct = isKeywordCorrect(game, text);
      const existing = await repo.getGameAnswer(userId, game.gameId, { consistent: true });
      if (!correct || isKeywordCorrect(game, existing?.text)) {
        return c.json({ game: toCurrentGameDto(game, existing, imageUrlOf), correct });
      }
      const answer = { gameId: game.gameId, userId, text, answeredAt: now().toISOString() };
      try {
        await repo.putGameAnswer(answer, { answeredAt: existing?.answeredAt });
      } catch (e) {
        if (!(e instanceof InvalidStateError)) throw e;
        // 同時に送られた別の答えが先に保存された（その答えのまま返す）
        const saved = await repo.getGameAnswer(userId, game.gameId, { consistent: true });
        return c.json({ game: toCurrentGameDto(game, saved, imageUrlOf), correct });
      }
      return c.json({ game: toCurrentGameDto(game, answer, imageUrlOf), correct: true });
    }
    // 時刻は開催中を確かめた後に付ける。この後に確定されて保存が遅れた答えは、点数の計算で除かれる
    const answer = {
      gameId: game.gameId,
      userId,
      choiceId,
      value,
      targetUserId,
      text,
      entry,
      answeredAt: now().toISOString(),
    };
    await repo.putGameAnswer(answer);
    return c.json({
      game: toCurrentGameDto(game, answer, imageUrlOf),
      ...(text !== undefined ? { correct: true } : {}),
    });
  });

  // 投票で選べる人（自分と、紐づけを解除した人を除く）。ゲームの画面を開いたときに 1 回だけ読む
  app.get("/game/:gameId/candidates", requireUser, async (c) => {
    const game = await repo.getGame(c.req.param("gameId") ?? "");
    if (!game) return fail(c, 404, "not_found");
    if (game.format !== "vote") return fail(c, 400, "bad_request", "投票のゲームではありません");
    if (game.status !== "open") return fail(c, 409, "game_closed");
    const me = c.get("user").userId;
    const candidates = (await repo.listUsers())
      .filter((u) => u.status === "active" && u.userId !== me)
      .sort((a, b) => a.name.localeCompare(b.name, "ja") || a.createdAt.localeCompare(b.createdAt))
      .map((u) => ({ userId: u.userId, displayName: formatDisplayName(u.epithet, u.name) }));
    return c.json({ candidates });
  });

  app.post("/photos/upload-url", requireUser, async (c) => {
    const photoId = newId();
    const { full, thumb } = await storage.createUploads(photoId, c.get("user").userId);
    return c.json({ photoId, full, thumb });
  });

  // 一覧を開いたままの画面でも写真が見え続けるよう、一覧の取得時にも写真用 Cookie を更新する
  app.get("/photos", requireUser, async (c) => {
    const [page, favoriteIds, settings] = await Promise.all([
      repo.listPhotosByStatus("approved", PHOTO_PAGE_SIZE, c.req.query("cursor")),
      repo.listFavoritePhotoIds(c.get("user").userId),
      repo.getSettings(),
    ]);
    const users = await uploadersOf(page.items);
    const favorites = new Set(favoriteIds);
    setPhotoCookies(c);
    return c.json({
      photos: page.items
        .filter(isVisible)
        .map((p) => toPhotoDto(p, users, { favorites, hideCounts: !settings.showPoints })),
      cursor: page.cursor,
    });
  });

  app.get("/photos/mine", requireUser, async (c) => {
    const user = c.get("user");
    const [photos, settings] = await Promise.all([repo.listPhotosByUploader(user.userId), repo.getSettings()]);
    const users = new Map([[user.userId, user]]);
    setPhotoCookies(c);
    return c.json({
      photos: photos.filter(isVisible).map((p) => toPhotoDto(p, users, { hideCounts: !settings.showPoints })),
    });
  });

  /** お気に入りの追加・解除。無効にされている間は締め切りとして、どちらも受け付けない */
  const changeFavorite = async (c: Context<Env>, action: "add" | "remove") => {
    const settings = await repo.getSettings();
    if (!settings.favoritesEnabled) return fail(c, 409, "favorites_disabled");
    const user = c.get("user");
    const photo = await repo.getPhoto(c.req.param("photoId") ?? "");
    if (!photo) return fail(c, 404, "not_found");
    if (photo.uploaderId === user.userId) return fail(c, 409, "invalid_state", "自分の写真は選べません");
    try {
      if (action === "add") await repo.addFavorite(user.userId, photo, settings.favoriteLimit, now().toISOString());
      else await repo.removeFavorite(user.userId, photo);
    } catch (e) {
      if (e instanceof FavoriteLimitError) return fail(c, 409, "favorite_limit");
      if (e instanceof InvalidStateError) return fail(c, 409, "invalid_state");
      throw e;
    }
    const [updatedPhoto, updatedUser, uploaders] = await Promise.all([
      repo.getPhoto(photo.photoId),
      repo.getUser(user.userId),
      uploadersOf([photo]),
    ]);
    if (!updatedPhoto || !isVisible(updatedPhoto) || !updatedUser) return fail(c, 404, "not_found");
    return c.json({
      photo: toPhotoDto(updatedPhoto, uploaders, {
        favorites: new Set(action === "add" ? [photo.photoId] : []),
        hideCounts: !settings.showPoints,
      }),
      user: await participantUser(updatedUser, settings),
    });
  };

  app.put("/photos/:photoId/favorite", requireUser, (c) => changeFavorite(c, "add"));
  app.delete("/photos/:photoId/favorite", requireUser, (c) => changeFavorite(c, "remove"));

  // ---- 管理者 ----

  app.post("/admin/login", async (c) => {
    const body = await parseBody(c, adminLoginRequestSchema);
    if (!body.ok) return body.response;
    if (!safeEqual(body.data.password, adminPassword)) return fail(c, 401, "unauthorized");

    const session: AdminSession = { adm: true, iat: nowSeconds() };
    setCookie(c, ADMIN_COOKIE, sign(session, sessionSecret), {
      httpOnly: true,
      secure: secureCookies,
      sameSite: "Strict",
      path: ADMIN_COOKIE_PATH,
      maxAge: ADMIN_SESSION_MAX_AGE,
    });
    return c.json({});
  });

  app.post("/admin/logout", (c) => {
    deleteCookie(c, ADMIN_COOKIE, { path: ADMIN_COOKIE_PATH, secure: secureCookies });
    return c.json({});
  });

  app.use("/admin/*", async (c, next) => {
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
  });

  app.get("/admin/me", (c) => c.json({}));

  app.post("/admin/tokens", async (c) => {
    const body = await parseBody(c, issueTokensRequestSchema);
    if (!body.ok) return body.response;
    const tokens = Array.from({ length: body.data.count }, newToken);
    const created = await repo.createTokens(tokens, now().toISOString());
    return c.json({ tokens: created.map((t) => toTokenDto(t)) }, 201);
  });

  app.get("/admin/tokens", async (c) => {
    const [tokens, users] = await Promise.all([repo.listTokens(), repo.listUsers()]);
    const byId = new Map(users.map((u) => [u.userId, u]));
    return c.json({ tokens: tokens.map((t) => toTokenDto(t, t.userId ? byId.get(t.userId) : undefined)) });
  });

  app.get("/admin/users", async (c) => {
    const [users, settings, scores] = await Promise.all([repo.listUsers(), repo.getSettings(), scoresOfAll()]);
    return c.json({ users: users.map((u) => toUserDto(u, settings, scores(u.userId))) });
  });

  app.get("/admin/ranking", async (c) => c.json(await loadRanking(await repo.getSettings())));

  app.patch("/admin/users/:userId", async (c) => {
    const body = await parseBody(c, updateUserRequestSchema);
    if (!body.ok) return body.response;
    try {
      const user = await repo.updateUser(c.req.param("userId"), body.data, now().toISOString());
      return c.json({ user: await adminUser(user) });
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      if (e instanceof EpithetTakenError) return fail(c, 409, "epithet_taken");
      throw e;
    }
  });

  app.post("/admin/users/:userId/unbind", async (c) => {
    try {
      const user = await repo.unbindUser(c.req.param("userId"), now().toISOString());
      return c.json({ user: await adminUser(user) });
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      throw e;
    }
  });

  app.get("/admin/photos", async (c) => {
    const status = photoStatusSchema.safeParse(c.req.query("status") ?? "pending");
    if (!status.success) return fail(c, 400, "bad_request");
    const page = await repo.listPhotosByStatus(status.data, PHOTO_PAGE_SIZE, c.req.query("cursor"));
    const users = await uploadersOf(page.items);
    return c.json({
      photos: page.items.filter(isVisible).map((p) => toPhotoDto(p, users, { signAll: true })),
      cursor: page.cursor,
    });
  });

  app.post("/admin/photos/:photoId/approve", async (c) => {
    const photoId = c.req.param("photoId");
    const photo = await repo.getPhoto(photoId);
    if (!photo) return fail(c, 404, "not_found");
    if (photo.status !== "pending") return fail(c, 409, "invalid_state");
    // 画像を先に公開領域へコピーし、DB を更新してから検閲待ちの画像を消す
    try {
      await storage.copy(photoId, "pending", "approved");
    } catch (e) {
      // 同時に別の承認・却下が先に済んで、検閲待ちの画像がもう無いとき（古い値を読まないよう、強い整合性で読む）
      if ((await repo.getPhoto(photoId, { consistent: true }))?.status !== "pending") {
        return fail(c, 409, "invalid_state");
      }
      throw e;
    }
    const approved = await photoAction(c, () => repo.approvePhoto(photoId, now().toISOString()));
    if (approved instanceof Response) {
      // DB の更新に失敗したら、公開領域へのコピーを取り消す。ただし同時に別の承認が先に済んでいたら、
      // その承認が公開した画像なので消さない（消すと、公開中のまま画像が無くなり元に戻せない）。
      // 直前の承認を見落とさないよう、強い整合性で読む
      if ((await repo.getPhoto(photoId, { consistent: true }))?.status !== "approved") {
        await storage.remove(photoId, "approved");
      }
      return approved;
    }
    await storage.remove(photoId, "pending");
    return c.json({ photo: toPhotoDto(approved as VisiblePhoto, await uploadersOf([approved]), { signAll: true }) });
  });

  app.post("/admin/photos/:photoId/reject", async (c) => {
    const photoId = c.req.param("photoId");
    const rejected = await photoAction(c, () => repo.rejectPhoto(photoId, now().toISOString()));
    if (rejected instanceof Response) return rejected;
    await storage.remove(photoId, "pending");
    return c.json({ photo: toPhotoDto(rejected as VisiblePhoto, await uploadersOf([rejected]), { signAll: true }) });
  });

  app.delete("/admin/photos/:photoId", async (c) => {
    const photoId = c.req.param("photoId");
    const photo = await repo.getPhoto(photoId);
    if (!photo) return fail(c, 404, "not_found");
    // 削除済みでも後片付けをやり直せるようにする（途中で失敗したときの再実行用）
    if (photo.status !== "deleted") {
      const deleted = await photoAction(c, () => repo.deleteApprovedPhoto(photoId, now().toISOString()));
      if (deleted instanceof Response) return deleted;
    }
    // 画像を先に消して見えなくしてから、お気に入りを外す（選んだ人の枠とアップロード者のポイントを戻す）
    await storage.remove(photoId, "approved");
    await storage.invalidate(photoId);
    await repo.clearFavorites(photoId);
    return c.json({});
  });

  app.get("/admin/prizes", async (c) => c.json({ prizes: (await repo.listPrizes()).map(toPrizeDto) }));

  app.post("/admin/prizes/image-upload", async (c) => {
    const imageId = newId();
    return c.json({ imageId, upload: await storage.createPrizeImageUpload(imageId) });
  });

  /** 新しく付ける画像を受け口から配信する領域へ移す。受け口に無ければ 400 のレスポンスを返す */
  const attachPrizeImage = async (c: Context, imageId: string | undefined, current?: string) => {
    if (imageId === undefined || imageId === current) return undefined;
    if (await storage.attachPrizeImage(imageId)) return undefined;
    return fail(c, 400, "bad_request", "画像がアップロードされていないか、ほかで使われています");
  };

  /** 使わなくなった画像を消す。景品・ゲームは保存できているので、消せなくても失敗にはしない（残った画像は Reset で消える） */
  const removePrizeImage = async (imageId: string) => {
    try {
      await storage.removePrizeImage(imageId);
    } catch (e) {
      console.error(`画像 ${imageId} の削除か、CloudFront のキャッシュの無効化に失敗しました`, e);
    }
  };

  /** ゲームが使っている画像（問題と選択肢） */
  const gameImageIds = (game: Pick<GameRecord, "imageId" | "choices">) =>
    [game.imageId, ...game.choices.map((ch) => ch.imageId)].filter((id): id is string => id !== undefined);

  /**
   * ゲームに新しく付ける画像（current に無いもの）を、受け口から配信する領域へ移す。
   * 1 つでも受け口に無ければ、移した分を消して 400 のレスポンスを返す
   */
  const attachGameImages = async (c: Context, imageIds: string[], current: string[] = []) => {
    const attached: string[] = [];
    for (const imageId of imageIds.filter((id) => !current.includes(id))) {
      if (!(await storage.attachPrizeImage(imageId))) {
        for (const id of attached) await removePrizeImage(id);
        return { response: fail(c, 400, "bad_request", "画像がアップロードされていないか、ほかで使われています") };
      }
      attached.push(imageId);
    }
    return { attached };
  };

  app.post("/admin/prizes", async (c) => {
    const body = await parseBody(c, prizeRequestSchema);
    if (!body.ok) return body.response;
    const invalid = await attachPrizeImage(c, body.data.imageId);
    if (invalid) return invalid;
    const timestamp = now().toISOString();
    const prize: PrizeRecord = {
      prizeId: newId(),
      name: body.data.name,
      quantity: body.data.quantity,
      positions: [...body.data.positions].sort((a, b) => a - b),
      imageId: body.data.imageId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      await repo.createPrize(prize);
    } catch (e) {
      if (prize.imageId) await removePrizeImage(prize.imageId);
      throw e;
    }
    return c.json({ prize: toPrizeDto(prize) }, 201);
  });

  app.put("/admin/prizes/:prizeId", async (c) => {
    const body = await parseBody(c, prizeRequestSchema);
    if (!body.ok) return body.response;
    const prize = await repo.getPrize(c.req.param("prizeId"));
    if (!prize) return fail(c, 404, "not_found");
    const invalid = await attachPrizeImage(c, body.data.imageId, prize.imageId);
    if (invalid) return invalid;
    try {
      const updated = await repo.updatePrize(
        prize.prizeId,
        {
          name: body.data.name,
          quantity: body.data.quantity,
          positions: [...body.data.positions].sort((a, b) => a - b),
          imageId: body.data.imageId,
        },
        now().toISOString(),
      );
      // 差し替えた・外した画像は、保存できてから消す
      if (prize.imageId && prize.imageId !== updated.imageId) await removePrizeImage(prize.imageId);
      return c.json({ prize: toPrizeDto(updated) });
    } catch (e) {
      // 保存できなかったら、新しく移した画像を消す
      if (body.data.imageId && body.data.imageId !== prize.imageId) await removePrizeImage(body.data.imageId);
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      throw e;
    }
  });

  app.delete("/admin/prizes/:prizeId", async (c) => {
    const prize = await repo.getPrize(c.req.param("prizeId"));
    if (!prize) return fail(c, 404, "not_found");
    try {
      await repo.deletePrize(prize.prizeId);
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      throw e;
    }
    if (prize.imageId) await removePrizeImage(prize.imageId);
    return c.json({});
  });

  app.get("/admin/schedule", async (c) => {
    const [items, settings] = await Promise.all([repo.listScheduleItems(), repo.getSettings()]);
    return c.json({ items: sortSchedule(items), date: settings.scheduleDate });
  });

  app.post("/admin/schedule", async (c) => {
    const body = await parseBody(c, scheduleItemRequestSchema);
    if (!body.ok) return body.response;
    const timestamp = now().toISOString();
    const item: ScheduleItemRecord = { itemId: newId(), ...body.data, createdAt: timestamp, updatedAt: timestamp };
    await repo.createScheduleItem(item);
    return c.json({ item: toScheduleItemDto(item) }, 201);
  });

  app.put("/admin/schedule/:itemId", async (c) => {
    const body = await parseBody(c, scheduleItemRequestSchema);
    if (!body.ok) return body.response;
    try {
      const item = await repo.updateScheduleItem(c.req.param("itemId"), body.data, now().toISOString());
      return c.json({ item: toScheduleItemDto(item) });
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      throw e;
    }
  });

  app.delete("/admin/schedule/:itemId", async (c) => {
    try {
      await repo.deleteScheduleItem(c.req.param("itemId"));
      return c.json({});
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      throw e;
    }
  });

  app.post("/admin/games/image-upload", async (c) => {
    const imageId = newId();
    return c.json({ imageId, upload: await storage.createPrizeImageUpload(imageId) });
  });

  app.get("/admin/games", async (c) => {
    const entries = await gamesWithAnswers();
    return c.json({ games: entries.map(({ game, answers }) => toGameDto(game, answers, imageUrlOf)) });
  });

  /** クイズ形式の答えた人の一覧 */
  app.get("/admin/games/:gameId/answers", async (c) => {
    const game = await repo.getGame(c.req.param("gameId"));
    if (!game) return fail(c, 404, "not_found");
    const answers = await repo.listGameAnswersByGame(game.gameId);
    const ids = new Set(answers.flatMap((a) => (a.targetUserId ? [a.userId, a.targetUserId] : [a.userId])));
    const users = new Map((await repo.getUsers([...ids])).map((u) => [u.userId, u]));
    const nameOf = (userId: string | undefined) => {
      const user = userId === undefined ? undefined : users.get(userId);
      return user ? formatDisplayName(user.epithet, user.name) : undefined;
    };
    return c.json({
      game: toGameDto(game, answers, imageUrlOf),
      answers: answers
        .sort((a, b) => a.answeredAt.localeCompare(b.answeredAt))
        .map((a) => {
          return {
            userId: a.userId,
            displayName: nameOf(a.userId),
            choiceId: a.choiceId,
            value: a.value,
            targetUserId: a.targetUserId,
            targetDisplayName: nameOf(a.targetUserId),
            text: a.text,
            entry: a.entry,
            answeredAt: a.answeredAt,
          };
        }),
    });
  });

  /**
   * 送られた枠を保存する形にする。既存の枠の ID と、選んだ人が登録済みかを確かめる（問題があれば 400 のレスポンス）。
   * 紐づけを解除した人は新しくは選べない（選んだ後に解除された人は、そのまま残せる）
   */
  const gameSlotsOf = async (
    c: Context,
    slots: NonNullable<GameRequest["slots"]>,
    existing: GameSlot[] = [],
  ): Promise<GameSlot[] | Response> => {
    const existingIds = new Set(existing.map((s) => s.slotId));
    if (slots.some((s) => s.slotId !== undefined && !existingIds.has(s.slotId))) {
      return fail(c, 400, "bad_request", "存在しない枠があります");
    }
    const userIds = [...new Set(slots.flatMap((s) => s.userIds))];
    const found = await repo.getUsers(userIds);
    if (found.length !== userIds.length) return fail(c, 400, "bad_request", "登録されていない人が選ばれています");
    const current = new Set(existing.flatMap((s) => s.userIds));
    if (found.some((u) => u.status !== "active" && !current.has(u.userId))) {
      return fail(c, 400, "bad_request", "紐づけを解除した人は選べません");
    }
    return slots.map((s) => ({ slotId: s.slotId ?? newId(), name: s.name, points: s.points, userIds: s.userIds }));
  };

  /** 送られた選択肢を保存する形にする。既存の選択肢を直すときは choiceId を付けて送る（無い ID は 400） */
  const gameChoicesOf = (
    c: Context,
    choices: NonNullable<GameRequest["choices"]>,
    existing: GameChoice[] = [],
  ): GameChoice[] | Response => {
    const existingIds = new Set(existing.map((ch) => ch.choiceId));
    if (choices.some((ch) => ch.choiceId !== undefined && !existingIds.has(ch.choiceId))) {
      return fail(c, 400, "bad_request", "存在しない選択肢があります");
    }
    return choices.map((ch) => ({
      choiceId: ch.choiceId ?? newId(),
      text: ch.text,
      points: ch.points,
      imageId: ch.imageId,
    }));
  };

  app.post("/admin/games", async (c) => {
    const body = await parseBody(c, gameRequestSchema);
    if (!body.ok) return body.response;
    const slots = await gameSlotsOf(c, body.data.slots ?? []);
    if (slots instanceof Response) return slots;
    const choices = gameChoicesOf(c, body.data.choices ?? []);
    if (choices instanceof Response) return choices;
    const timestamp = now().toISOString();
    const game: GameRecord = {
      gameId: newId(),
      format: body.data.format,
      name: body.data.name,
      description: body.data.description ?? "",
      imageId: body.data.imageId,
      status: "draft",
      slots,
      choices,
      ranks: sortRanks(body.data.ranks ?? []),
      correctNumber: body.data.correctNumber,
      voterPoints: body.data.voterPoints ?? 0,
      keyword: body.data.keyword,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const images = await attachGameImages(c, gameImageIds(game));
    if (images.response) return images.response;
    try {
      await repo.createGame(game);
    } catch (e) {
      for (const id of images.attached) await removePrizeImage(id);
      throw e;
    }
    return c.json({ game: toGameDto(game, [], imageUrlOf) }, 201);
  });

  // 開催中・確定済みでも直せる（ポイントは直した内容で数え直し、推移では確定した時刻のまま）。
  // クイズの選択肢を増やす・減らすのは、答えと食い違わないよう、まだ答えが無い下書きの間だけ
  app.put("/admin/games/:gameId", async (c) => {
    const body = await parseBody(c, gameRequestSchema);
    if (!body.ok) return body.response;
    const game = await repo.getGame(c.req.param("gameId"));
    if (!game) return fail(c, 404, "not_found");
    if (body.data.format !== game.format) return fail(c, 400, "bad_request", "ゲームの形式は変えられません");
    if (body.data.baseUpdatedAt !== undefined && body.data.baseUpdatedAt !== game.updatedAt) {
      return fail(c, 409, "invalid_state", GAME_CONFLICT_MESSAGE);
    }
    const slots = await gameSlotsOf(c, body.data.slots ?? [], game.slots);
    if (slots instanceof Response) return slots;
    const choices = gameChoicesOf(c, body.data.choices ?? [], game.choices);
    if (choices instanceof Response) return choices;
    const sentIds = new Set((body.data.choices ?? []).flatMap((ch) => (ch.choiceId ? [ch.choiceId] : [])));
    const structureChanged =
      choices.length !== game.choices.length || game.choices.some((ch) => !sentIds.has(ch.choiceId));
    const answers = hasGameAnswers(game) ? await repo.listGameAnswersByGame(game.gameId) : [];
    if (structureChanged && (game.status !== "draft" || answers.length > 0)) {
      return fail(c, 409, "invalid_state", "答えがある・開催した後のクイズは、選択肢を増やしたり減らしたりできません");
    }
    // 確定したゲームから、確定に要るもの（結果入力の枠、正解の数、点数の範囲）を全部外すと、
    // 入ったポイントが黙って消えるので受け付けない（確定できない形には直せない）。
    // 以前の版で既に外してあるゲームは、名前などを直せるようにそのまま通す
    if (
      game.status === "confirmed" &&
      !gameConfirmProblem(game) &&
      gameConfirmProblem({
        format: game.format,
        slots,
        ranks: body.data.ranks ?? [],
        correctNumber: body.data.correctNumber,
      })
    ) {
      return fail(
        c,
        409,
        "invalid_state",
        "確定したゲームの枠・正解の数・点数の範囲は、全部は外せません。先に確定を取り消してください",
      );
    }
    const changes = {
      name: body.data.name,
      description: body.data.description ?? "",
      imageId: body.data.imageId,
      slots,
      choices,
      ranks: sortRanks(body.data.ranks ?? []),
      correctNumber: body.data.correctNumber,
      voterPoints: body.data.voterPoints ?? 0,
      keyword: body.data.keyword,
    };
    const before = gameImageIds(game);
    const after = gameImageIds(changes);
    const images = await attachGameImages(c, after, before);
    if (images.response) return images.response;
    try {
      const updated = await repo.updateGame(game.gameId, changes, now().toISOString(), body.data.baseUpdatedAt);
      // 差し替えた・外した画像は、保存できてから消す
      for (const id of before.filter((id) => !after.includes(id))) await removePrizeImage(id);
      return c.json({ game: toGameDto(updated, answers, imageUrlOf) });
    } catch (e) {
      // 保存できなかったら、新しく移した画像を消す
      for (const id of images.attached) await removePrizeImage(id);
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      if (e instanceof InvalidStateError) return fail(c, 409, "invalid_state", GAME_CONFLICT_MESSAGE);
      throw e;
    }
  });

  /**
   * 参加者の一覧（GSI）は結果整合なので、確定の直前の参加がまだ出ていないことがある。開催中の抽選を確定するときは、
   * 一度読んでから少し待ってもう一度読み、どちらかに出た人を合わせる（抽選は確定のときの順番を保存し、後から直らないため）。
   * 確定の時刻は 2 回目の読み取りの直前に決めるので、待っている間の参加も数える
   */
  const readLotteryEntrants = async (game: GameRecord) => {
    const read = async () => (await repo.listGameAnswersByGame(game.gameId)).filter((a) => a.entry);
    // 下書きからの確定は、新しい参加が無い（開催中しか参加できない）ので待たない
    const first = game.status === "open" ? await read() : [];
    if (game.status === "open") await settle();
    const at = now().toISOString();
    const entrants = [...first, ...(await read())].filter((a) => a.answeredAt <= at).map((a) => a.userId);
    return { at, entrants: [...new Set(entrants)] };
  };

  /** 抽選の順番を決める。紐づけを解除した人（会場を離れた人）は除き、userId で並べてから並べ替える */
  const drawLottery = async (entrants: string[]) => {
    const active = (await repo.getUsers(entrants)).filter((u) => u.status === "active").map((u) => u.userId);
    return shuffle(active.sort(), rand);
  };

  /** 状態を変える。from は今の状態の前提（違えば 409） */
  const changeGameStatus = async (c: Context, game: GameRecord, to: GameRecord["status"], message: string) => {
    try {
      // 抽選は確定するときに、確定までに参加した人の順番を無作為に決めて保存する（確定し直すと引き直す）
      const lottery = to === "confirmed" && game.format === "lottery" ? await readLotteryEntrants(game) : undefined;
      const at = lottery?.at ?? now().toISOString();
      const drawOrder = lottery ? await drawLottery(lottery.entrants) : undefined;
      const updated = await repo.changeGameStatus(game.gameId, game.status, to, at, drawOrder);
      const answers = hasGameAnswers(updated) ? await repo.listGameAnswersByGame(updated.gameId) : [];
      return c.json({ game: toGameDto(updated, answers, imageUrlOf) });
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      if (e instanceof GameAlreadyOpenError) {
        return fail(c, 409, "invalid_state", "別のゲームが開催中です。確定するか、開催をやめてから開催してください");
      }
      if (e instanceof InvalidStateError) return fail(c, 409, "invalid_state", message);
      throw e;
    }
  };

  /** 状態の操作。allowed は操作できる今の状態 */
  const gameAction =
    (
      to: GameRecord["status"],
      allowed: GameRecord["status"][],
      message: string,
      check?: (game: GameRecord) => string | undefined,
    ) =>
    async (c: Context) => {
      const game = await repo.getGame(c.req.param("gameId") ?? "");
      if (!game) return fail(c, 404, "not_found");
      if (!allowed.includes(game.status)) return fail(c, 409, "invalid_state", message);
      const problem = check?.(game);
      if (problem) return fail(c, 409, "invalid_state", problem);
      return changeGameStatus(c, game, to, message);
    };

  app.post("/admin/games/:gameId/open", gameAction("open", ["draft"], "開催できるのは下書きのゲームだけです"));
  app.post("/admin/games/:gameId/stop", gameAction("draft", ["open"], "開催中のゲームではありません"));
  // 入るポイントが決まらないゲーム（枠の無い結果入力、正解の数か点数の範囲が無い数値予想）は確定させない
  app.post(
    "/admin/games/:gameId/confirm",
    gameAction("confirmed", ["draft", "open"], "既に確定しています", gameConfirmProblem),
  );
  app.post("/admin/games/:gameId/unconfirm", gameAction("draft", ["confirmed"], "確定していません"));

  app.delete("/admin/games/:gameId", async (c) => {
    const game = await repo.getGame(c.req.param("gameId"));
    if (!game) return fail(c, 404, "not_found");
    try {
      await repo.deleteGame(game.gameId);
      for (const id of gameImageIds(game)) await removePrizeImage(id);
      return c.json({});
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      if (e instanceof InvalidStateError) {
        return fail(c, 409, "invalid_state", "開催中のゲームは、開催をやめてから削除してください");
      }
      throw e;
    }
  });

  app.get("/admin/settings", async (c) => c.json({ settings: await repo.getSettings() }));

  app.put("/admin/settings", async (c) => {
    const body = await parseBody(c, updateSettingsRequestSchema);
    if (!body.ok) return body.response;
    const settings = { ...(await repo.getSettings()), ...body.data };
    await repo.putSettings(settings);
    return c.json({ settings });
  });

  return app;
}

/** 参加者・管理画面に出す写真（削除済みの記録は出さない） */
type VisiblePhoto = PhotoRecord & { status: PhotoStatus };

function isVisible(photo: PhotoRecord): photo is VisiblePhoto {
  return photo.status !== "deleted";
}

/** 写真の状態遷移を実行し、想定内の失敗は API エラーのレスポンスにする */
async function photoAction(c: Context, action: () => Promise<PhotoRecord>): Promise<PhotoRecord | Response> {
  try {
    return await action();
  } catch (e) {
    if (e instanceof NotFoundError) return fail(c, 404, "not_found");
    if (e instanceof InvalidStateError) return fail(c, 409, "invalid_state");
    throw e;
  }
}

/** ゲームと、クイズ形式の答え（結果入力形式では空） */
export interface GameWithAnswers {
  game: GameRecord;
  answers: GameAnswerRecord[];
}

/** ゲームを、そのゲームに答えた分だけと組にする（1 人分の答えから点数を数えるとき） */
function withAnswers(games: GameRecord[], answers: GameAnswerRecord[]): GameWithAnswers[] {
  return games.map((game) => ({ game, answers: answers.filter((a) => a.gameId === game.gameId) }));
}

interface GameStats {
  /** 確定したゲームで入った点数の合計 */
  points: number;
  /** 点数が入ったもの（確定した順） */
  awards: GameAwardDto[];
}

const NO_GAME_STATS: GameStats = { points: 0, awards: [] };

interface GameAward extends GameAwardDto {
  userId: string;
  /** 確定した時刻（推移ではこの時刻に入る） */
  at: string;
}

/**
 * 確定したゲームで、誰に何点入ったか（確定した順）。下書き・開催中のゲームは数えない
 * （クイズを選び直して、点数の変化から正解が分からないように）。
 * 結果入力は枠に入った人に枠の点数、クイズは選んだ選択肢の点数、数値予想は正解に近い順の順位が入る範囲の点数、
 * 投票は得票の順位が入る範囲の点数（選ばれた人）と、投票した人の点数、合言葉は正解した順が入る範囲の点数、
 * 抽選は確定したときに決めた順番が入る範囲の点数。確定の直前に受け付けて確定の後に保存された答え
 * （answeredAt > confirmedAt）は数えない
 */
function gameAwards(entries: GameWithAnswers[]): GameAward[] {
  const awards: GameAward[] = [];
  const confirmed = entries
    .filter(
      (e): e is GameWithAnswers & { game: { confirmedAt: string } } =>
        e.game.status === "confirmed" && !!e.game.confirmedAt,
    )
    .sort((a, b) => a.game.confirmedAt.localeCompare(b.game.confirmedAt));
  for (const { game, answers: all } of confirmed) {
    const at = game.confirmedAt;
    // 数える答え（確定より後に届いた答えと、今の合言葉に合わない答えを除く）。管理画面の回答数と同じ数え方
    const answers = countedAnswers(game, all);
    if (game.format === "result") {
      for (const slot of game.slots) {
        for (const userId of slot.userIds) {
          awards.push({ userId, at, gameName: game.name, slotName: slot.name, points: slot.points });
        }
      }
    } else if (game.format === "quiz") {
      const choices = new Map(game.choices.map((ch) => [ch.choiceId, ch]));
      for (const answer of answers) {
        const choice = answer.choiceId === undefined ? undefined : choices.get(answer.choiceId);
        if (!choice) continue;
        awards.push({ userId: answer.userId, at, gameName: game.name, slotName: choice.text, points: choice.points });
      }
    } else if (game.correctNumber !== undefined) {
      const counted = answers.filter((a): a is GameAnswerRecord & { value: number } => a.value !== undefined);
      const results = rankNumberAnswers(
        counted.map((a) => a.value),
        game.correctNumber,
        game.ranks,
      );
      counted.forEach((answer, i) => {
        const { rank, points } = results[i]!;
        awards.push({
          userId: answer.userId,
          at,
          gameName: game.name,
          slotName: `${rank} 位（予想 ${answer.value}）`,
          points,
        });
      });
    } else if (game.format === "vote") {
      const counted = answers.filter(
        (a): a is GameAnswerRecord & { targetUserId: string } => a.targetUserId !== undefined,
      );
      for (const { userId, votes, rank, points } of tallyVotes(
        counted.map((a) => a.targetUserId),
        game.ranks,
      )) {
        awards.push({ userId, at, gameName: game.name, slotName: `${rank} 位（${votes} 票）`, points });
      }
      if (game.voterPoints > 0) {
        for (const answer of counted) {
          awards.push({ userId: answer.userId, at, gameName: game.name, slotName: "投票", points: game.voterPoints });
        }
      }
    } else if (game.format === "keyword") {
      // 今の合言葉に合う答えを、正解した時刻の順に並べる（同じ時刻は userId の順）
      const correct = answers
        .slice()
        .sort((a, b) => a.answeredAt.localeCompare(b.answeredAt) || a.userId.localeCompare(b.userId));
      correct.forEach((answer, i) => {
        const range = game.ranks.find((r) => r.from <= i + 1 && i + 1 <= r.to);
        awards.push({
          userId: answer.userId,
          at,
          gameName: game.name,
          slotName: `${i + 1} 番目に正解`,
          points: range?.points ?? 0,
        });
      });
    } else if (game.format === "lottery") {
      // 確定したときに決めた順番で、範囲に入った人に点数を入れる
      (game.drawOrder ?? []).forEach((userId, i) => {
        const range = game.ranks.find((r) => r.from <= i + 1 && i + 1 <= r.to);
        if (!range) return;
        awards.push({
          userId,
          at,
          gameName: game.name,
          slotName: `${formatRankRange(range, "等")}に当選`,
          points: range.points,
        });
      });
    }
  }
  return awards;
}

/** 全員分のゲームの点数と、点数が入ったもの */
function gameStatsByUser(entries: GameWithAnswers[]): Map<string, GameStats> {
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

function toUserDto(user: UserRecord, settings: Settings, game: GameStats): UserDto {
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
function toParticipantUserDto(user: UserRecord, settings: Settings, game: GameStats): UserDto {
  const { points, favoritesReceived, gamePoints, ...rest } = toUserDto(user, settings, game);
  return {
    ...rest,
    ...(settings.showPoints ? { points, favoritesReceived } : {}),
    ...(settings.showGamePoints ? { gamePoints, gameAwards: game.awards } : {}),
  };
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

function toScheduleItemDto(item: ScheduleItemRecord): ScheduleItemDto {
  return {
    itemId: item.itemId,
    title: item.title,
    detail: item.detail,
    startMinute: item.startMinute,
    durationMinutes: item.durationMinutes,
  };
}

/** 開始時刻の早い順（同じなら作った順） */
function sortSchedule(items: ScheduleItemRecord[]): ScheduleItemDto[] {
  return [...items].sort((a, b) => a.startMinute - b.startMinute).map(toScheduleItemDto);
}

type ImageUrlOf = (imageId: string | undefined) => string | undefined;

/** 合言葉に合っているか（表記の揺れは normalizeKeyword でなくす）。合言葉が無ければ合わない */
function isKeywordCorrect(game: Pick<GameRecord, "keyword">, text: string | undefined): boolean {
  return game.keyword !== undefined && text !== undefined && normalizeKeyword(text) === normalizeKeyword(game.keyword);
}

/** 数値予想の点数の範囲を、順位の小さい順に */
function sortRanks(ranks: GameRank[]): GameRank[] {
  return [...ranks].sort((a, b) => a.from - b.from).map(({ from, to, points }) => ({ from, to, points }));
}

/**
 * 数える答え。点数の計算（gameAwards）と管理画面の回答数で共通。確定したゲームでは確定より後に届いた答えを除き、
 * 合言葉は今の合言葉に合う答えだけ、確定した抽選は抽選に入った人だけを数える
 */
function countedAnswers(game: GameRecord, answers: GameAnswerRecord[]): GameAnswerRecord[] {
  const at = game.status === "confirmed" ? game.confirmedAt : undefined;
  // 抽選は確定したら、抽選に入った人（drawOrder）だけを数える
  const drawn = game.format === "lottery" && game.drawOrder ? new Set(game.drawOrder) : undefined;
  return answers.filter(
    (a) =>
      (at === undefined || a.answeredAt <= at) &&
      (game.format !== "keyword" || isKeywordCorrect(game, a.text)) &&
      (drawn === undefined || drawn.has(a.userId)),
  );
}

function toGameDto(game: GameRecord, allAnswers: GameAnswerRecord[], imageUrlOf: ImageUrlOf): GameDto {
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
function toCurrentGameDto(
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

function toRules(settings: Settings): Rules {
  const { moderation: _moderation, ...rules } = settings;
  return rules;
}

function toTokenDto(token: TokenRecord, user?: UserRecord): TokenDto {
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

function fail(c: Context, status: ContentfulStatusCode, error: ApiErrorCode, message?: string) {
  return c.json({ error, message }, status);
}

async function parseBody<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: Response }> {
  const json = await c.req.json().catch(() => undefined);
  const result = schema.safeParse(json);
  if (!result.success) {
    return { ok: false, response: fail(c, 400, "bad_request", result.error.issues[0]?.message) };
  }
  return { ok: true, data: result.data };
}
