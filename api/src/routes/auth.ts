import {
  adminLoginRequestSchema,
  isPinLocked,
  PIN_MAX_FAILURES,
  qrLoginRequestSchema,
  randomEpithet,
  registerRequestSchema,
} from "@partally/shared";
import type { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { toRules } from "../dto.js";
import { type Env, fail, parseBody } from "../http.js";
import { hashPin, verifyPin } from "../pin.js";
import { EpithetTakenError, TokenNotAvailableError, type UserRecord } from "../repository.js";
import { ADMIN_SESSION_MAX_AGE, type AdminSession, safeEqual, sign } from "../session.js";
import { ADMIN_COOKIE, ADMIN_COOKIE_PATH, type AppContext, USER_COOKIE } from "./context.js";

const EPITHET_ATTEMPTS = 10;

export function registerAuthRoutes(app: Hono<Env>, ctx: AppContext) {
  const {
    repo,
    sessionSecret,
    adminPassword,
    secureCookies,
    now,
    rand,
    newId,
    nowSeconds,
    setUserSession,
    setPhotoCookies,
    participantUser,
    requireUser,
    userSessionOf,
  } = ctx;

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
    const login = async () => {
      setUserSession(c, { ...user, token: token.token });
      return c.json({ status: "bound" as const, user: await participantUser(user) });
    };

    // その人としてログインしたままの端末なら、暗証番号は聞かない
    const session = userSessionOf(c);
    if (session?.uid === user.userId && session.tok === token.token) return login();

    const { pin } = body.data;
    if (!user.pinHash) {
      // 暗証番号をまだ決めていない（登録が暗証番号より前・幹事が消した）。送られた番号を暗証番号にする。
      // 同時に別の端末で決められていたら、決めずに、もう一度番号を聞く
      if (pin === undefined) return c.json({ status: "pin_required" as const, setup: true });
      if (!(await repo.setUserPin(user.userId, await hashPin(pin), true))) {
        return c.json({ status: "pin_required" as const, setup: false });
      }
      return login();
    }

    if (isPinLocked(user.pinFailures)) return fail(c, 423, "pin_locked");
    if (pin === undefined) return c.json({ status: "pin_required" as const, setup: false });
    // 試す前に回数を数える（同時に何回送っても、決めた回数までしか試せない）
    if (!(await repo.reservePinAttempt(user.userId, PIN_MAX_FAILURES))) return fail(c, 423, "pin_locked");
    if (!(await verifyPin(pin, user.pinHash))) {
      const left = PIN_MAX_FAILURES - (user.pinFailures ?? 0) - 1;
      return left > 0 ? fail(c, 401, "pin_invalid", `あと ${left} 回`) : fail(c, 423, "pin_locked");
    }
    await repo.resetPinFailures(user.userId);
    return login();
  });

  app.post("/auth/register", async (c) => {
    const body = await parseBody(c, registerRequestSchema);
    if (!body.ok) return body.response;
    const { token, name, pin } = body.data;

    const existing = await repo.getToken(token);
    if (!existing) return fail(c, 404, "invalid_token");
    if (existing.status !== "unbound") return fail(c, 409, "token_already_bound");

    const timestamp = now().toISOString();
    const userId = newId();
    const pinHash = await hashPin(pin);
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
        pinHash,
        pinFailures: 0,
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

  app.get("/me", requireUser, async (c) => {
    // 写真用の署名付き Cookie は有効期間が短いので、アプリを開くたびに更新する
    setPhotoCookies(c);
    const settings = await repo.getSettings();
    return c.json({ user: await participantUser(c.get("user"), settings), rules: toRules(settings) });
  });

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

  app.get("/admin/me", (c) => c.json({}));
}
