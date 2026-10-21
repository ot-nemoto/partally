import { randomBytes, randomInt } from "node:crypto";
import {
  type ApiErrorCode,
  adminLoginRequestSchema,
  type CurrentQuizDto,
  formatDisplayName,
  issueTokensRequestSchema,
  type PhotoDto,
  type PhotoStatus,
  photoStatusSchema,
  type QuizDto,
  qrLoginRequestSchema,
  quizAnswerRequestSchema,
  quizRequestSchema,
  type RandomInt,
  type Rules,
  randomEpithet,
  registerRequestSchema,
  type Settings,
  type TokenDto,
  type UserDto,
  updateSettingsRequestSchema,
  updateUserRequestSchema,
} from "@partally/shared";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ulid } from "ulid";
import type { z } from "zod";
import { type PhotoStorage, photoPath } from "./photo-storage.js";
import {
  EpithetTakenError,
  FavoriteLimitError,
  InvalidStateError,
  NotFoundError,
  type PhotoRecord,
  QuizAlreadyOpenError,
  type QuizAnswerRecord,
  type QuizChoice,
  type QuizRecord,
  type Repository,
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

  /** 一覧に出てくるアップロード者だけを取得する */
  const uploadersOf = async (photos: PhotoRecord[]) =>
    new Map((await repo.getUsers(photos.map((p) => p.uploaderId))).map((u) => [u.userId, u]));

  /** 1 人分のクイズの回答数と点数 */
  const quizStatsOf = async (userId: string): Promise<QuizStats> => {
    const [quizzes, answers] = await Promise.all([repo.listQuizzes(), repo.listQuizAnswersByUser(userId)]);
    return scoreQuizAnswers(answers, quizzes);
  };

  /** 全員分のクイズの回答数と点数（管理画面のユーザ一覧用） */
  const quizStatsOfAll = async (): Promise<Map<string, QuizStats>> => {
    const quizzes = await repo.listQuizzes();
    const answers = (await Promise.all(quizzes.map((q) => repo.listQuizAnswersByQuiz(q.quizId)))).flat();
    const byUser = new Map<string, QuizAnswerRecord[]>();
    for (const a of answers) byUser.set(a.userId, [...(byUser.get(a.userId) ?? []), a]);
    return new Map([...byUser].map(([userId, list]) => [userId, scoreQuizAnswers(list, quizzes)]));
  };

  /** ユーザ情報を、設定とクイズの成績を添えて参加者向けに返す */
  const participantUser = async (user: UserRecord, settings?: Settings) => {
    const [resolved, quiz] = await Promise.all([settings ?? repo.getSettings(), quizStatsOf(user.userId)]);
    return toParticipantUserDto(user, resolved, quiz);
  };

  const adminUser = async (user: UserRecord) => {
    const [settings, quiz] = await Promise.all([repo.getSettings(), quizStatsOf(user.userId)]);
    return toUserDto(user, settings, quiz);
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

  app.get("/me", requireUser, async (c) => {
    // 写真用の署名付き Cookie は有効期間が短いので、アプリを開くたびに更新する
    setPhotoCookies(c);
    const settings = await repo.getSettings();
    return c.json({ user: await participantUser(c.get("user"), settings), rules: toRules(settings) });
  });

  // 参加者の画面が数秒ごとに呼ぶので、読み込みは最小限にする
  app.get("/quiz/current", requireUser, async (c) => {
    const quizId = await repo.getOpenQuizId();
    const quiz = quizId ? await repo.getQuiz(quizId) : undefined;
    if (quiz?.status !== "open") return c.json({ quiz: null });
    const answer = await repo.getQuizAnswer(c.get("user").userId, quiz.quizId);
    return c.json({ quiz: toCurrentQuizDto(quiz, answer?.choiceId) });
  });

  app.put("/quiz/:quizId/answer", requireUser, async (c) => {
    const body = await parseBody(c, quizAnswerRequestSchema);
    if (!body.ok) return body.response;
    const quiz = await repo.getQuiz(c.req.param("quizId") ?? "");
    if (!quiz) return fail(c, 404, "not_found");
    if (quiz.status !== "open") return fail(c, 409, "quiz_closed");
    const { choiceId } = body.data;
    if (!quiz.choices.some((ch) => ch.choiceId === choiceId)) return fail(c, 400, "bad_request", "選択肢がありません");
    try {
      await repo.putQuizAnswer({
        quizId: quiz.quizId,
        userId: c.get("user").userId,
        choiceId,
        answeredAt: now().toISOString(),
      });
    } catch (e) {
      if (e instanceof InvalidStateError) return fail(c, 409, "quiz_closed");
      throw e;
    }
    return c.json({ quiz: toCurrentQuizDto(quiz, choiceId) });
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
    const [users, settings, quizStats] = await Promise.all([repo.listUsers(), repo.getSettings(), quizStatsOfAll()]);
    return c.json({ users: users.map((u) => toUserDto(u, settings, quizStats.get(u.userId) ?? NO_QUIZ_STATS)) });
  });

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
    // 画像を先に公開領域へコピーし、DB を更新してから検閲待ちの画像を消す。
    // 同時に却下されるなどで DB の更新に失敗したら、公開領域へのコピーを取り消す
    await storage.copy(photoId, "pending", "approved");
    const approved = await photoAction(c, () => repo.approvePhoto(photoId, now().toISOString()));
    if (approved instanceof Response) {
      await storage.remove(photoId, "approved");
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

  app.get("/admin/quizzes", async (c) => {
    const quizzes = await repo.listQuizzes();
    const answers = await Promise.all(quizzes.map((q) => repo.listQuizAnswersByQuiz(q.quizId)));
    return c.json({ quizzes: quizzes.map((q, i) => toQuizDto(q, answers[i]!)) });
  });

  app.post("/admin/quizzes", async (c) => {
    const body = await parseBody(c, quizRequestSchema);
    if (!body.ok) return body.response;
    if (body.data.choices.some((ch) => ch.choiceId !== undefined)) {
      return fail(c, 400, "bad_request", "新しい問題の選択肢に choiceId は指定できません");
    }
    const timestamp = now().toISOString();
    const quiz: QuizRecord = {
      quizId: newId(),
      text: body.data.text,
      choices: body.data.choices.map((ch) => ({ choiceId: newId(), text: ch.text, points: ch.points })),
      status: "draft",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await repo.createQuiz(quiz);
    return c.json({ quiz: toQuizDto(quiz, []) }, 201);
  });

  app.get("/admin/quizzes/:quizId", async (c) => {
    const quiz = await repo.getQuiz(c.req.param("quizId"));
    if (!quiz) return fail(c, 404, "not_found");
    const answers = await repo.listQuizAnswersByQuiz(quiz.quizId);
    const users = new Map((await repo.getUsers(answers.map((a) => a.userId))).map((u) => [u.userId, u]));
    return c.json({
      quiz: toQuizDto(quiz, answers),
      answers: answers
        .sort((a, b) => a.answeredAt.localeCompare(b.answeredAt))
        .map((a) => {
          const user = users.get(a.userId);
          return {
            userId: a.userId,
            displayName: user ? formatDisplayName(user.epithet, user.name) : undefined,
            choiceId: a.choiceId,
            answeredAt: a.answeredAt,
          };
        }),
    });
  });

  // 問題文と選択肢の文言・点数はいつでも直せる（点数を直すと締め切り済みの分も数え直す）。
  // 選択肢の追加・削除は、回答と食い違わないよう下書きの間だけ
  app.put("/admin/quizzes/:quizId", async (c) => {
    const body = await parseBody(c, quizRequestSchema);
    if (!body.ok) return body.response;
    const quiz = await repo.getQuiz(c.req.param("quizId"));
    if (!quiz) return fail(c, 404, "not_found");
    const existingIds = new Set(quiz.choices.map((ch) => ch.choiceId));
    if (body.data.choices.some((ch) => ch.choiceId !== undefined && !existingIds.has(ch.choiceId))) {
      return fail(c, 400, "bad_request", "存在しない選択肢があります");
    }
    const choices: QuizChoice[] = body.data.choices.map((ch) => ({
      choiceId: ch.choiceId ?? newId(),
      text: ch.text,
      points: ch.points,
    }));
    const keptIds = new Set(body.data.choices.flatMap((ch) => (ch.choiceId ? [ch.choiceId] : [])));
    const structureChanged = keptIds.size !== choices.length || keptIds.size !== existingIds.size;
    if (structureChanged && quiz.status !== "draft") {
      return fail(c, 409, "invalid_state", "出題した後は選択肢を増やしたり減らしたりできません");
    }
    try {
      const updated = await repo.updateQuiz(
        quiz.quizId,
        { text: body.data.text, choices },
        now().toISOString(),
        structureChanged,
      );
      return c.json({ quiz: toQuizDto(updated, await repo.listQuizAnswersByQuiz(quiz.quizId)) });
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      if (e instanceof InvalidStateError) {
        return fail(c, 409, "invalid_state", "出題した後は選択肢を増やしたり減らしたりできません");
      }
      throw e;
    }
  });

  app.delete("/admin/quizzes/:quizId", async (c) => {
    try {
      await repo.deleteQuiz(c.req.param("quizId"));
      return c.json({});
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      if (e instanceof InvalidStateError)
        return fail(c, 409, "invalid_state", "出題中の問題は締め切ってから削除してください");
      throw e;
    }
  });

  app.post("/admin/quizzes/:quizId/open", async (c) => {
    try {
      const quiz = await repo.openQuiz(c.req.param("quizId"), now().toISOString());
      return c.json({ quiz: toQuizDto(quiz, []) });
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      if (e instanceof QuizAlreadyOpenError)
        return fail(c, 409, "invalid_state", "別の問題が出題中です。締め切ってから出題してください");
      if (e instanceof InvalidStateError) return fail(c, 409, "invalid_state", "出題できるのは下書きの問題だけです");
      throw e;
    }
  });

  app.post("/admin/quizzes/:quizId/close", async (c) => {
    try {
      const quiz = await repo.closeQuiz(c.req.param("quizId"), now().toISOString());
      return c.json({ quiz: toQuizDto(quiz, await repo.listQuizAnswersByQuiz(quiz.quizId)) });
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      if (e instanceof InvalidStateError) return fail(c, 409, "invalid_state", "出題中の問題ではありません");
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

interface QuizStats {
  /** 回答したクイズの数（削除されたクイズは数えない） */
  answered: number;
  /** 締め切ったクイズで選んだ選択肢の点数の合計 */
  points: number;
}

const NO_QUIZ_STATS: QuizStats = { answered: 0, points: 0 };

/**
 * 回答を点数にする。出題中のクイズは数えない（選び直して点数の変化から正解がわからないように）。
 * 締め切りの直前に受け付けて締め切り後に保存された回答（answeredAt > closedAt）も数えない
 */
export function scoreQuizAnswers(answers: QuizAnswerRecord[], quizzes: QuizRecord[]): QuizStats {
  const byId = new Map(quizzes.map((q) => [q.quizId, q]));
  let answered = 0;
  let points = 0;
  for (const answer of answers) {
    const quiz = byId.get(answer.quizId);
    if (!quiz) continue;
    answered++;
    if (quiz.status !== "closed" || !quiz.closedAt || answer.answeredAt > quiz.closedAt) continue;
    points += quiz.choices.find((ch) => ch.choiceId === answer.choiceId)?.points ?? 0;
  }
  return { answered, points };
}

/** ポイントは保存せず、現在の設定で毎回計算する（設定を変えると全員に同じ基準で反映される） */
export function calculatePoints(user: UserRecord, settings: Settings, quiz: QuizStats): number {
  return user.approvedCount * settings.uploadPoints + user.favoritesReceived * settings.favoritePoints + quiz.points;
}

function toUserDto(user: UserRecord, settings: Settings, quiz: QuizStats): UserDto {
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
    quizAnswered: quiz.answered,
    quizPoints: quiz.points,
    points: calculatePoints(user, settings, quiz),
    createdAt: user.createdAt,
  };
}

/** 参加者本人に返すユーザ情報。ポイントを伏せている間は、ポイントとその元になる選ばれた数・クイズの点数を含めない */
function toParticipantUserDto(user: UserRecord, settings: Settings, quiz: QuizStats): UserDto {
  const dto = toUserDto(user, settings, quiz);
  if (settings.showPoints) return dto;
  const { points: _points, favoritesReceived: _favoritesReceived, quizPoints: _quizPoints, ...rest } = dto;
  return rest;
}

function toQuizDto(quiz: QuizRecord, answers: QuizAnswerRecord[]): QuizDto {
  const counts = new Map<string, number>();
  for (const a of answers) counts.set(a.choiceId, (counts.get(a.choiceId) ?? 0) + 1);
  return {
    quizId: quiz.quizId,
    text: quiz.text,
    status: quiz.status,
    choices: quiz.choices.map((ch) => ({ ...ch, answerCount: counts.get(ch.choiceId) ?? 0 })),
    answerCount: answers.length,
    createdAt: quiz.createdAt,
    openedAt: quiz.openedAt,
    closedAt: quiz.closedAt,
  };
}

/** 参加者に返すクイズ。正解がわからないよう、選択肢の点数は含めない */
function toCurrentQuizDto(quiz: QuizRecord, myChoiceId: string | undefined): CurrentQuizDto {
  return {
    quizId: quiz.quizId,
    text: quiz.text,
    choices: quiz.choices.map(({ choiceId, text }) => ({ choiceId, text })),
    myChoiceId,
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
