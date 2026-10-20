import { randomBytes, randomInt } from "node:crypto";
import {
  type ApiErrorCode,
  adminLoginRequestSchema,
  formatDisplayName,
  issueTokensRequestSchema,
  type PhotoDto,
  photoStatusSchema,
  qrLoginRequestSchema,
  type RandomInt,
  randomEpithet,
  registerRequestSchema,
  type TokenDto,
  updateSettingsRequestSchema,
  updateUserRequestSchema,
  type UserDto,
} from "@partally/shared";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ulid } from "ulid";
import type { z } from "zod";
import { type PhotoStorage, photoPath } from "./photo-storage.js";
import {
  EpithetTakenError,
  InvalidStateError,
  NotFoundError,
  type PhotoRecord,
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
/** 検閲待ち写真・管理画面の署名付き URL の有効期間 */
const SIGNED_URL_TTL_MS = 10 * 60 * 1000;
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

  /** 公開済み写真は Cookie で、検閲待ち（と signAll 指定時はすべて）は署名付き URL で見せる */
  const toPhotoDto = (photo: PhotoRecord, users: Map<string, UserRecord>, signAll = false): PhotoDto => {
    const uploader = users.get(photo.uploaderId);
    const dto: PhotoDto = {
      photoId: photo.photoId,
      uploaderId: photo.uploaderId,
      uploaderName: uploader ? formatDisplayName(uploader.epithet, uploader.name) : undefined,
      status: photo.status,
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

  const usersById = async () => new Map((await repo.listUsers()).map((u) => [u.userId, u]));

  app.post("/auth/qr", async (c) => {
    const body = await parseBody(c, qrLoginRequestSchema);
    if (!body.ok) return body.response;

    const token = await repo.getToken(body.data.token);
    if (!token) return fail(c, 404, "invalid_token");
    if (token.status === "unbound" || !token.userId) return c.json({ status: "unbound" as const });

    const user = await repo.getUser(token.userId);
    if (!user || user.status !== "active" || user.token !== token.token) {
      // トークンとユーザの状態が食い違っている。管理者に紐づけ解除してもらう必要がある
      return fail(c, 404, "invalid_token");
    }
    setUserSession(c, { ...user, token: token.token });
    return c.json({ status: "bound" as const, user: toUserDto(user) });
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
      return c.json({ user: toUserDto(user) }, 201);
    }
    throw new Error(`二つ名を ${EPITHET_ATTEMPTS} 回抽選しても空きが見つかりませんでした`);
  });

  app.post("/auth/logout", (c) => {
    deleteCookie(c, USER_COOKIE, { path: "/", secure: secureCookies });
    return c.json({});
  });

  const requireUser = async (c: Context<Env>, next: () => Promise<void>) => {
    const session = verify<UserSession>(
      getCookie(c, USER_COOKIE),
      sessionSecret,
      USER_SESSION_MAX_AGE,
      nowSeconds(),
    );
    const user = session && (await repo.getUser(session.uid));
    if (!session || !user || user.status !== "active" || user.token !== session.tok) {
      deleteCookie(c, USER_COOKIE, { path: "/", secure: secureCookies });
      return fail(c, 401, "unauthorized");
    }
    c.set("user", user);
    await next();
  };

  app.get("/me", requireUser, (c) => {
    // 写真用の署名付き Cookie は有効期間が短いので、アプリを開くたびに更新する
    setPhotoCookies(c);
    return c.json({ user: toUserDto(c.get("user")) });
  });

  app.post("/photos/upload-url", requireUser, async (c) => {
    const photoId = newId();
    const { full, thumb } = await storage.createUploads(photoId, c.get("user").userId);
    return c.json({ photoId, full, thumb });
  });

  app.get("/photos", requireUser, async (c) => {
    const page = await repo.listPhotosByStatus("approved", PHOTO_PAGE_SIZE, c.req.query("cursor"));
    const users = await usersById();
    return c.json({ photos: page.items.map((p) => toPhotoDto(p, users)), cursor: page.cursor });
  });

  app.get("/photos/mine", requireUser, async (c) => {
    const user = c.get("user");
    const photos = await repo.listPhotosByUploader(user.userId);
    const users = new Map([[user.userId, user]]);
    return c.json({ photos: photos.map((p) => toPhotoDto(p, users)) });
  });

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
    const users = await repo.listUsers();
    return c.json({ users: users.map(toUserDto) });
  });

  app.patch("/admin/users/:userId", async (c) => {
    const body = await parseBody(c, updateUserRequestSchema);
    if (!body.ok) return body.response;
    try {
      const user = await repo.updateUser(c.req.param("userId"), body.data, now().toISOString());
      return c.json({ user: toUserDto(user) });
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      if (e instanceof EpithetTakenError) return fail(c, 409, "epithet_taken");
      throw e;
    }
  });

  app.post("/admin/users/:userId/unbind", async (c) => {
    try {
      const user = await repo.unbindUser(c.req.param("userId"), now().toISOString());
      return c.json({ user: toUserDto(user) });
    } catch (e) {
      if (e instanceof NotFoundError) return fail(c, 404, "not_found");
      throw e;
    }
  });

  app.get("/admin/photos", async (c) => {
    const status = photoStatusSchema.safeParse(c.req.query("status") ?? "pending");
    if (!status.success) return fail(c, 400, "bad_request");
    const page = await repo.listPhotosByStatus(status.data, PHOTO_PAGE_SIZE, c.req.query("cursor"));
    const users = await usersById();
    return c.json({ photos: page.items.map((p) => toPhotoDto(p, users, true)), cursor: page.cursor });
  });

  app.post("/admin/photos/:photoId/approve", async (c) => {
    const photoId = c.req.param("photoId");
    const photo = await repo.getPhoto(photoId);
    if (!photo) return fail(c, 404, "not_found");
    if (photo.status !== "pending") return fail(c, 409, "invalid_state");
    // 画像を先に公開領域へコピーし、DB を更新してから検閲待ちの画像を消す
    await storage.copyToApproved(photoId);
    const approved = await photoAction(c, () => repo.approvePhoto(photoId, now().toISOString()));
    if (approved instanceof Response) return approved;
    await storage.remove(photoId, "pending");
    return c.json({ photo: toPhotoDto(approved, await usersById(), true) });
  });

  app.post("/admin/photos/:photoId/reject", async (c) => {
    const photoId = c.req.param("photoId");
    const rejected = await photoAction(c, () => repo.rejectPhoto(photoId, now().toISOString()));
    if (rejected instanceof Response) return rejected;
    await storage.remove(photoId, "pending");
    return c.json({ photo: toPhotoDto(rejected, await usersById(), true) });
  });

  app.delete("/admin/photos/:photoId", async (c) => {
    const photoId = c.req.param("photoId");
    const deleted = await photoAction(c, () => repo.deleteApprovedPhoto(photoId));
    if (deleted instanceof Response) return deleted;
    await storage.remove(photoId, "approved");
    await storage.invalidate(photoId);
    return c.json({});
  });

  app.get("/admin/settings", async (c) => c.json({ settings: await repo.getSettings() }));

  app.put("/admin/settings", async (c) => {
    const body = await parseBody(c, updateSettingsRequestSchema);
    if (!body.ok) return body.response;
    await repo.putSettings(body.data);
    return c.json({ settings: body.data });
  });

  return app;
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

function toUserDto(user: UserRecord): UserDto {
  return {
    userId: user.userId,
    name: user.name,
    epithet: user.epithet,
    displayName: formatDisplayName(user.epithet, user.name),
    status: user.status,
    uploadCount: user.uploadCount,
    approvedCount: user.approvedCount,
    createdAt: user.createdAt,
  };
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
